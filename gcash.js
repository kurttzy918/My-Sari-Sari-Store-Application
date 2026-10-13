/* gcash.js — GCash cash-in/cash-out tracking + Auto-generated Payment QR */
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc,
  serverTimestamp, query, where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { state, CONSTANTS } from "./state.js";
import {
  $, valOf, setVal, esc, debounce, safeRender, showToast,
  myWorkspace, playSuccessSound,
  fmtInt, fmtMoney, downloadXLSX, downloadPDF, printHTML
} from "./utils.js";
import { openScanner, forceCloseScanner } from "./inventory.js";

/* =========================================================
   TRANSACTION TYPES
   ========================================================= */
const GCASH_TYPES = {
  "cash-in":  { label: "Cash-In",        icon: "📥", gcashDir: "out" },
  "cash-out": { label: "Cash-Out",       icon: "📤", gcashDir: "in"  },
  "send":     { label: "Send Money",     icon: "➡️", gcashDir: "out" },
  "bills":    { label: "Bills Payment",  icon: "🧾", gcashDir: "out" },
  "load":     { label: "Load / Buy",     icon: "📱", gcashDir: "out" },
  "receive":  { label: "Received Money", icon: "💰", gcashDir: "in"  },
  "other":    { label: "Other",          icon: "💠", gcashDir: "out" }
};

const OPENING_KEY  = (ws) => `gcashOpeningBalance:${ws}`;
const SETTINGS_KEY = (ws) => `gcashSettings:${ws}`;

/* =========================================================
   OPENING BALANCE
   ========================================================= */
function getOpeningBalance() {
  const ws = myWorkspace(); if (!ws) return 0;
  try { return Number(localStorage.getItem(OPENING_KEY(ws))) || 0; }
  catch { return 0; }
}
function setOpeningBalance(val) {
  const ws = myWorkspace(); if (!ws) return;
  try { localStorage.setItem(OPENING_KEY(ws), String(Number(val) || 0)); } catch {}
}

/* =========================================================
   GCASH SETTINGS
   ========================================================= */
function getGcashSettings() {
  const ws = myWorkspace();
  if (!ws) return { number: "", name: "" };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY(ws));
    if (raw) {
      const p = JSON.parse(raw);
      return { number: p.number || "", name: p.name || "" };
    }
  } catch (e) { console.warn("[gcash settings] parse:", e); }
  return { number: "", name: "" };
}

function setGcashSettings(s) {
  const ws = myWorkspace(); if (!ws) return;
  try {
    localStorage.setItem(SETTINGS_KEY(ws), JSON.stringify({
      number: s.number || "",
      name:   s.name   || ""
    }));
  } catch (e) { console.warn("[gcash settings] save:", e); }
}

/* =========================================================
   QR PAYLOAD BUILDER  (used by the Payment QR modal only)
   ========================================================= */
function buildQrPayload({ number, name, amount, reference, note }) {
  const lines = [
    "GCASH PAYMENT",
    "─────────────",
    `Amount : ₱${Number(amount || 0).toFixed(2)}`,
    `To     : ${number || "—"}`,
    `Name   : ${name || "—"}`,
    `Ref    : ${reference || "—"}`
  ];
  if (note) lines.push(`Note   : ${note}`);
  return lines.join("\n");
}

/* =========================================================
   QR RENDER HELPER — waits for library, retries, and falls back
   ========================================================= */
let _qrReadyPromise = null;

function waitForQrLibrary(timeoutMs = 12000) {
  if (typeof window.QRCode !== "undefined" && typeof window.QRCode.toCanvas === "function") {
    return Promise.resolve(window.QRCode);
  }
  if (_qrReadyPromise) return _qrReadyPromise;

  _qrReadyPromise = new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (typeof window.QRCode !== "undefined" && typeof window.QRCode.toCanvas === "function") {
        return resolve(window.QRCode);
      }
      if (Date.now() - started > timeoutMs) {
        _qrReadyPromise = null;
        return reject(new Error("QRCode library never loaded"));
      }
      setTimeout(tick, 200);
    };
    tick();
  });
  return _qrReadyPromise;
}

function drawQrMessage(canvas, lines, opts = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = opts.bg || "#F1F5F7";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = opts.color || "#64748B";
  ctx.font = "13px -apple-system, 'Segoe UI', Roboto, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const arr = Array.isArray(lines) ? lines : [lines];
  const step = 20;
  const startY = h / 2 - ((arr.length - 1) * step) / 2;
  arr.forEach((line, i) => ctx.fillText(line, w / 2, startY + i * step));
}

async function renderQr(canvas, text, opts = {}) {
  if (!canvas) return;
  const size = opts.width || 260;

  canvas.width = size;
  canvas.height = size;
  canvas.style.width  = size + "px";
  canvas.style.height = size + "px";
  canvas.style.flexShrink = "0";

  let QRCode;
  try {
    QRCode = await waitForQrLibrary();
  } catch (err) {
    console.error("[gcash qr]", err.message);
    drawQrMessage(canvas, [
      "QR library failed to load.",
      "Check your internet connection",
      "and reload the page."
    ], { bg: "#FEF3C7", color: "#92400E" });
    return;
  }

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (e) => { if (settled) return; settled = true; e ? reject(e) : resolve(); };
      const maybePromise = QRCode.toCanvas(canvas, String(text), {
        width: size,
        margin: opts.margin ?? 2,
        color: opts.color || { dark: "#0B6FDE", light: "#FFFFFF" },
        errorCorrectionLevel: "M"
      }, (err) => done(err));
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(() => done(null), done);
      }
      setTimeout(() => done(new Error("QR render timeout")), 5000);
    });
  } catch (e) {
    console.error("[gcash qr] render failed:", e);
    drawQrMessage(canvas, ["QR generation failed."], { bg: "#FEE2E2", color: "#991B1B" });
  }
}

/* =========================================================
   EMVCo TLV PARSER — handles nested tags
   ========================================================= */
function parseEmvCoTlv(text) {
  const tags = {};
  let i = 0;
  while (i < text.length - 3) {
    const tag = text.substr(i, 2);
    const len = parseInt(text.substr(i + 2, 2), 10);
    if (isNaN(len) || len < 0) break;
    if (i + 4 + len > text.length) break;
    const value = text.substr(i + 4, len);
    tags[tag] = value;
    i += 4 + len;
  }
  return Object.keys(tags).length ? tags : null;
}

/* =========================================================
   QR PARSER — extracts customer info from any scanned QR
   Handles: URL · JSON · EMVCo/QR Ph · key:value · phone · plain
   ========================================================= */
function parseQrPayload(text) {
  const raw = String(text || "").trim();
  const out = {
    raw,
    name: "",
    number: "",
    amount: null,
    reference: "",
    note: ""
  };
  if (!raw) return out;

  /* ---------- 1) URL with query params ---------- */
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const p = u.searchParams;
      out.name      = p.get("name") || p.get("n") || p.get("accountName") || "";
      out.number    = p.get("number") || p.get("phone") || p.get("p") || p.get("msisdn") || "";
      out.reference = p.get("reference") || p.get("ref") || "";
      out.amount    = p.get("amount") ? Number(p.get("amount")) : null;
      out.note      = p.get("note") || "";
      if (out.name || out.number) return out;
    } catch {}
  }

  /* ---------- 2) JSON ---------- */
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw);
      out.name      = j.name || j.customerName || j.accountName || j.merchantName || "";
      out.number    = j.number || j.phone || j.mobile || j.msisdn || "";
      out.reference = j.reference || j.ref || "";
      out.amount    = j.amount ?? null;
      out.note      = j.note || "";
      if (out.name || out.number) return out;
    } catch {}
  }

  /* ---------- 3) EMVCo TLV (QR Ph / GCash standard) ---------- */
  try {
    const tlv = parseEmvCoTlv(raw);
    if (tlv) {
      /* Merchant Account Information — tags 26–51
         Sub-tag 00 = GUID (e.g. "ph.ppmi.p2m")
         Sub-tag 01 = account number / GCash number
         Sub-tag 02 = alternate account number
      */
      for (const merchantTag of ["26", "27", "28", "29", "30", "31", "32", "33"]) {
        const block = tlv[merchantTag];
        if (!block) continue;
        const sub = parseEmvCoTlv(block);
        if (!sub) continue;

        // GCash numbers: sub-tag 01 is usually the primary ID
        if (sub["01"] && !out.number) {
          out.number = String(sub["01"]).trim();
        }
        // Fallback: some providers use 02 or 03
        if (sub["02"] && !out.number && /^\d{7,}$/.test(String(sub["02"]))) {
          out.number = String(sub["02"]).trim();
        }
        // Merchant/customer name inside the block (rare but possible)
        if (sub["00"] && !out.name && /[A-Za-z]/.test(String(sub["00"]))) {
          // GUID strings like "ph.ppmi.p2m" aren't names — skip those
          const candidate = String(sub["00"]).trim();
          if (!/^ph\.[a-z0-9.]+$/i.test(candidate)) out.name = candidate;
        }
      }

      // Merchant/Customer Name — tag 59
      if (tlv["59"]) out.name = String(tlv["59"]).trim();

      // Merchant City — tag 60
      if (tlv["60"]) out.note = out.note || String(tlv["60"]).trim();

      // Amount — tag 54
      if (tlv["54"]) out.amount = Number(tlv["54"]) || null;

      // Additional Data Field — tag 62
      if (tlv["62"]) {
        const sub = parseEmvCoTlv(tlv["62"]);
        if (sub?.["01"]) out.reference = String(sub["01"]).trim();
        if (sub?.["05"] && !out.reference) out.reference = String(sub["05"]).trim();
        if (sub?.["07"] && !out.reference) out.reference = String(sub["07"]).trim();
      }

      if (out.name || out.number) return out;
    }
  } catch (e) {
    console.warn("[gcash qr] EMVCo parse failed:", e);
  }

  /* ---------- 4) Key : Value lines ---------- */
  const kv = {};
  raw.split(/[\n\r;|,]+/).forEach(line => {
    const m = line.match(/^\s*([A-Za-z0-9 _-]{2,24})\s*[:=]\s*(.+?)\s*$/);
    if (m) kv[m[1].trim().toLowerCase()] = m[2].trim();
  });
  if (Object.keys(kv).length) {
    out.name      = kv["name"] || kv["customer"] || kv["account name"] || kv["accountname"] || "";
    out.number    = kv["number"] || kv["phone"] || kv["mobile"] || kv["msisdn"] || "";
    out.reference = kv["ref"] || kv["reference"] || "";
    if (out.name || out.number) return out;
  }

  /* ---------- 5) Philippine mobile number anywhere in the text ---------- */
  const phone = raw.match(/(?:\+?63|0)?9\d{9}/);
  if (phone) out.number = phone[0];

  /* ---------- 6) Fallback — short plain text becomes the name ---------- */
  if (!out.name && !out.number && raw.length <= 80 && !/^\d+$/.test(raw)) {
    out.name = raw;
  }

  return out;
}

/* =========================================================
   SCANNED-QR HANDLER — auto-fill customer info + clear display
   ========================================================= */
function handleScannedCustomerQr(text) {
  const parsed = parseQrPayload(text);

  /* ---------- Show a clear, labeled result panel ---------- */
  const resultEl = $("gcash-scan-result");
  if (resultEl) {
    const hasAny = parsed.name || parsed.number || parsed.reference || parsed.amount;

    if (!hasAny) {
      resultEl.innerHTML = `
        <div class="gcash-scan-empty">
          <div class="gcash-scan-empty-icon">⚠️</div>
          <div class="gcash-scan-empty-text">No customer info found in this QR</div>
          <div class="gcash-scan-empty-raw">${esc(parsed.raw.slice(0, 60))}</div>
        </div>`;
      showToast("QR scanned — no customer info found ⚠️");
      return;
    }

    resultEl.innerHTML = `
      <div class="gcash-scan-success-head">
        <span class="gcash-scan-success-icon">✅</span>
        <span class="gcash-scan-success-title">Customer Scanned</span>
      </div>

      ${parsed.name ? `
        <div class="gcash-scan-result-row">
          <span class="gcash-scan-result-label">Account Name</span>
          <strong class="gcash-scan-result-value">${esc(parsed.name)}</strong>
        </div>` : ""}

      ${parsed.number ? `
        <div class="gcash-scan-result-row">
          <span class="gcash-scan-result-label">GCash Number</span>
          <strong class="gcash-scan-result-value mono">${esc(parsed.number)}</strong>
        </div>` : ""}

      ${parsed.reference ? `
        <div class="gcash-scan-result-row">
          <span class="gcash-scan-result-label">Reference</span>
          <strong class="gcash-scan-result-value mono">${esc(parsed.reference)}</strong>
        </div>` : ""}

      ${parsed.amount ? `
        <div class="gcash-scan-result-row">
          <span class="gcash-scan-result-label">Amount</span>
          <strong class="gcash-scan-result-value">₱${Number(parsed.amount).toFixed(2)}</strong>
        </div>` : ""}
    `;

    // Success animation pulse
    resultEl.classList.add("gcash-scan-pop");
    setTimeout(() => resultEl.classList.remove("gcash-scan-pop"), 900);
  }

  /* ---------- Auto-fill transaction form fields ---------- */

  // 1) Customer name → Customer field
  const custEl = $("gcash-customer");
  if (custEl && parsed.name) {
    custEl.value = parsed.name;
    custEl.classList.add("gcash-autofilled");
    setTimeout(() => custEl.classList.remove("gcash-autofilled"), 1300);
  } else if (custEl && !custEl.value && parsed.number) {
    // Fallback: use the number as the customer identifier
    custEl.value = parsed.number;
    custEl.classList.add("gcash-autofilled");
    setTimeout(() => custEl.classList.remove("gcash-autofilled"), 1300);
  }

  // 2) Reference → use the customer's GCash number if no reference and no value
  const refEl = $("gcash-reference");
  if (refEl && !refEl.value) {
    if (parsed.reference) {
      refEl.value = parsed.reference;
    } else if (parsed.number) {
      refEl.value = parsed.number;
    }
    if (refEl.value) {
      refEl.classList.add("gcash-autofilled");
      setTimeout(() => refEl.classList.remove("gcash-autofilled"), 1300);
    }
  }

  // 3) Amount → fill only if the field is empty and the QR had an amount
  const amtEl = $("gcash-amount");
  if (amtEl && !amtEl.value && parsed.amount) {
    amtEl.value = Number(parsed.amount).toFixed(2);
    amtEl.classList.add("gcash-autofilled");
    setTimeout(() => amtEl.classList.remove("gcash-autofilled"), 1300);
  }

  // 4) Note → store the customer's GCash number for the transaction record
  const noteEl = $("gcash-note");
  if (noteEl && !noteEl.value && parsed.number) {
    noteEl.value = `Customer GCash: ${parsed.number}`;
  }

  playSuccessSound();
  showToast(
    parsed.name && parsed.number
      ? `Scanned: ${parsed.name} · ${parsed.number} ✅`
      : parsed.name
        ? `Scanned: ${parsed.name} ✅`
        : parsed.number
          ? `Scanned: ${parsed.number} ✅`
          : "QR scanned ✅"
  );
}

/* =========================================================
   SETTINGS FORM
   ========================================================= */
function loadGcashSettingsIntoForm() {
  const s = getGcashSettings();
  setVal($("gcash-number"), s.number);
  setVal($("gcash-account-name"), s.name);
}

function wireGcashSettings() {
  loadGcashSettingsIntoForm();

  /* Save button */
  $("gcash-save-settings")?.addEventListener("click", () => {
    setGcashSettings({
      number: valOf($("gcash-number")).trim(),
      name:   valOf($("gcash-account-name")).trim()
    });
    playSuccessSound();
    showToast("GCash settings saved ✅");
  });

  /* Scan Customer QR — reuses the shared camera scanner */
  $("gcash-scan-qr-btn")?.addEventListener("click", () => {
    openScanner("gcash-customer", (scannedText) => {
      // Close the camera first (custom callback still runs synchronously)
      forceCloseScanner();
      handleScannedCustomerQr(scannedText);
    });
  });
}

/* =========================================================
   PAYMENT QR MODAL (unchanged — still generates a QR per transaction)
   ========================================================= */
let _currentQrTxn = null;

export function openGcashPaymentQR(txnId) {
  const t = state.gcashTransactions.find(x => x.id === txnId);
  if (!t) { showToast("Transaction not found ❌"); return; }
  _currentQrTxn = t;

  const s = getGcashSettings();

  if (!s.number) {
    showToast("Set your GCash number in Settings first ⚠️");
    document.querySelector(".gcash-settings-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  const amtEl = $("gcash-pay-amount");
  const refEl = $("gcash-pay-ref");
  const numEl = $("gcash-pay-number");
  const nameEl = $("gcash-pay-name");
  const canvasEl = $("gcash-pay-qr-canvas");
  const hintEl = $("gcash-payment-hint");

  const ref = t.reference || t.id.slice(0, 10).toUpperCase();

  if (amtEl) amtEl.textContent = fmtMoney(t.amount);
  if (refEl) refEl.textContent = ref;
  if (numEl) numEl.textContent = s.number;
  if (nameEl) nameEl.textContent = s.name || "—";

  const payload = buildQrPayload({
    number: s.number,
    name: s.name,
    amount: t.amount,
    reference: ref,
    note: t.note || ""
  });
  renderQr(canvasEl, payload, { width: 260 });

  if (hintEl) {
    hintEl.textContent =
      "Show this to the customer. They can scan the QR with any phone to see the amount, your number, and the reference — then send via their GCash app.";
  }

  $("gcash-payment-modal")?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}
window.openGcashPaymentQR = openGcashPaymentQR;

function closeGcashPaymentQR() {
  $("gcash-payment-modal")?.classList.add("hidden");
  document.body.style.overflow = "";
  _currentQrTxn = null;
}

function printCurrentGcashPayment() {
  const t = _currentQrTxn;
  if (!t) return;
  const meta = GCASH_TYPES[t.type] || GCASH_TYPES.other;
  const s = getGcashSettings();
  const date = t.createdAt?.toDate?.().toLocaleString() || "—";
  const ref = t.reference || t.id.slice(0, 10).toUpperCase();

  const qrImgSrc = document.getElementById("gcash-pay-qr-canvas")?.toDataURL?.("image/png") || "";

  printHTML(`
    <h1>GCash Payment</h1>
    <div class="meta">${esc(CONSTANTS.STORE_NAME)} · ${esc(date)}</div>
    <table>
      <tr><th style="width:180px">Transaction</th><td>${esc(meta.label)}</td></tr>
      <tr><th>Amount to Pay</th><td><strong>${fmtMoney(t.amount)}</strong></td></tr>
      <tr><th>Reference</th><td>${esc(ref)}</td></tr>
      <tr><th>GCash Number</th><td>${esc(s.number || "—")}</td></tr>
      <tr><th>Account Name</th><td>${esc(s.name || "—")}</td></tr>
    </table>
    ${qrImgSrc ? `<div style="text-align:center;margin-top:24px;"><img src="${qrImgSrc}" alt="QR" style="max-width:260px;border:1px solid #ccc;border-radius:12px;padding:8px;" /></div>` : ""}
    <p style="margin-top:18px;text-align:center;font-size:12px;color:#666;">
      Scan the QR to see payment details.
    </p>
  `, "GCash Payment");
}

function wireGcashPaymentModal() {
  $("gcash-payment-close")?.addEventListener("click", closeGcashPaymentQR);
  $("gcash-pay-done")?.addEventListener("click", closeGcashPaymentQR);
  $("gcash-pay-print")?.addEventListener("click", printCurrentGcashPayment);
  $("gcash-payment-modal")?.addEventListener("click", (e) => {
    if (e.target === $("gcash-payment-modal")) closeGcashPaymentQR();
  });
}

/* =========================================================
   TRANSACTION FORM
   ========================================================= */
function populateTypeSelect() {
  const sel = $("gcash-type"); if (!sel) return;
  sel.innerHTML = Object.entries(GCASH_TYPES)
    .map(([k, v]) => `<option value="${k}">${v.icon} ${esc(v.label)}</option>`)
    .join("");
  sel.value = "cash-in";
}

function wireGcashForm() {
  const form = $("gcash-form"); if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const wsId = myWorkspace();
    if (!wsId) { showToast("Workspace not ready ❌"); return; }

    const idEl = $("gcash-id");
    const wasEditing = !!(idEl && idEl.value);

    const type = valOf($("gcash-type")) || "cash-in";
    const amount = Number(valOf($("gcash-amount")));
    const fee = Number(valOf($("gcash-fee"))) || 0;

    if (!amount || amount <= 0) { showToast("Amount must be greater than 0 ❌"); return; }
    if (fee < 0) { showToast("Fee cannot be negative ❌"); return; }

    const data = {
      workspaceId: wsId,
      type,
      amount,
      fee,
      customerName: valOf($("gcash-customer")).trim(),
      reference: valOf($("gcash-reference")).trim(),
      note: valOf($("gcash-note")).trim(),
      updatedAt: serverTimestamp()
    };

    try {
      if (wasEditing) {
        await updateDoc(doc(db, "gcash_transactions", idEl.value), data);
        showToast("Transaction updated ✅");
      } else {
        await addDoc(collection(db, "gcash_transactions"), {
          ...data,
          createdAt: serverTimestamp(),
          userId: state.currentUser?.uid || null
        });
        showToast("Transaction recorded ✅");
        playSuccessSound();
      }
      resetGcashForm();
    } catch (err) {
      showToast(`Failed: ${err.code || err.message} ❌`);
    }
  });

  $("gcash-cancel-edit")?.addEventListener("click", resetGcashForm);
}

function resetGcashForm() {
  const form = $("gcash-form"); if (!form) return;
  form.reset();
  const idEl = $("gcash-id"); if (idEl) idEl.value = "";
  if ($("gcash-type")) $("gcash-type").value = "cash-in";
  if ($("gcash-form-title")) $("gcash-form-title").textContent = "Record GCash Transaction";
  $("gcash-cancel-edit")?.classList.add("hidden");
}

export function editGcash(id) {
  const t = state.gcashTransactions.find(x => x.id === id);
  if (!t) return;
  setVal($("gcash-id"), t.id);
  setVal($("gcash-type"), t.type || "cash-in");
  setVal($("gcash-amount"), t.amount ?? "");
  setVal($("gcash-fee"), t.fee ?? "");
  setVal($("gcash-customer"), t.customerName || "");
  setVal($("gcash-reference"), t.reference || "");
  setVal($("gcash-note"), t.note || "");
  if ($("gcash-form-title")) $("gcash-form-title").textContent = "Edit GCash Transaction";
  $("gcash-cancel-edit")?.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
window.editGcash = editGcash;

export async function deleteGcash(id) {
  const t = state.gcashTransactions.find(x => x.id === id);
  if (!t) return;
  const meta = GCASH_TYPES[t.type] || GCASH_TYPES.other;
  if (!confirm(`Delete this GCash transaction?\n\n${meta.label} · ${fmtMoney(t.amount)}`)) return;
  try {
    await deleteDoc(doc(db, "gcash_transactions", id));
    showToast("Transaction deleted 🗑️");
  } catch (err) { showToast(`Failed: ${err.code || err.message} ❌`); }
}
window.deleteGcash = deleteGcash;

/* =========================================================
   SUMMARY
   ========================================================= */
function getTodayBounds() {
  const t = new Date(); t.setHours(0,0,0,0);
  const start = t.getTime();
  return { start, end: start + 24 * 60 * 60 * 1000 };
}
function getMonthStart() {
  const d = new Date(); d.setDate(1); d.setHours(0,0,0,0);
  return d.getTime();
}

function renderGcashSummary() {
  const { start, end } = getTodayBounds();
  const monthStart = getMonthStart();

  let inToday = 0, outToday = 0, feeToday = 0;
  let inCount = 0, outCount = 0;
  let feeMonth = 0, totalIn = 0, totalOut = 0;

  state.gcashTransactions.forEach(t => {
    const ms = t.createdAt?.toMillis?.() ?? 0;
    const meta = GCASH_TYPES[t.type] || GCASH_TYPES.other;
    const amt = Number(t.amount) || 0;
    const fee = Number(t.fee) || 0;

    // Wallet balance uses gcashDir (GCash wallet up/down)
    if (meta.gcashDir === "in") totalIn += amt;
    else totalOut += amt;

    // Summary cards use the transaction type's own meaning:
    //   cash-in  → money IN  to the store
    //   receive  → money IN  to the store
    //   everything else → money OUT of the store
    const isStoreIn = (t.type === "cash-in" || t.type === "receive");

    if (ms >= start && ms < end) {
      if (isStoreIn) { inToday += amt; inCount++; }
      else           { outToday += amt; outCount++; }
      feeToday += fee;
    }
    if (ms >= monthStart) feeMonth += fee;
  });

  const opening = getOpeningBalance();
  const balance = opening + totalIn - totalOut;

  const setTxt = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  setTxt("gcash-in-today", fmtMoney(inToday));
  setTxt("gcash-out-today", fmtMoney(outToday));
  setTxt("gcash-fee-today", fmtMoney(feeToday));
  setTxt("gcash-balance", fmtMoney(balance));

  const setCount = (id, n) => {
    const el = $(id);
    if (el) el.textContent = `${fmtInt(n)} transaction${n !== 1 ? "s" : ""}`;
  };
  setCount("gcash-in-count", inCount);
  setCount("gcash-out-count", outCount);
  setTxt("gcash-fee-month", `This month: ${fmtMoney(feeMonth)}`);
}

/* =========================================================
   LIST
   ========================================================= */
function getFilteredGcash() {
  const term = valOf($("gcash-search")).toLowerCase().trim();
  const typeFilter = valOf($("gcash-filter-type"));
  const range = valOf($("gcash-filter-range"));

  let list = state.gcashTransactions.slice();

  if (typeFilter) list = list.filter(t => t.type === typeFilter);

  if (range) {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    let cutoff = 0;
    if (range === "today") { const t = new Date(); t.setHours(0,0,0,0); cutoff = t.getTime(); }
    else if (range === "7") cutoff = now - 7 * dayMs;
    else if (range === "30") cutoff = now - 30 * dayMs;
    list = list.filter(t => (t.createdAt?.toMillis?.() ?? 0) >= cutoff);
  }

  if (term) {
    list = list.filter(t =>
      (t.customerName || "").toLowerCase().includes(term) ||
      (t.reference || "").toLowerCase().includes(term) ||
      (t.note || "").toLowerCase().includes(term)
    );
  }
  return list;
}

function renderGcashList() {
  const list = $("gcash-list"); if (!list) return;
  const filtered = getFilteredGcash();

  if (!filtered.length) {
    list.innerHTML = `
      <div class="empty-state">
        <img src="gcash.png" alt="" class="gcash-empty-logo" />
        <p>No GCash transactions yet — record one above.</p>
      </div>`;
    return;
  }

  list.innerHTML = filtered.slice(0, 100).map(t => {
    const meta = GCASH_TYPES[t.type] || GCASH_TYPES.other;
    const date = t.createdAt?.toDate?.().toLocaleString() || "—";
    const isIn = meta.gcashDir === "in";
    return `
      <div class="gcash-row">
        <div class="gcash-icon ${isIn ? "in" : "out"}">${meta.icon}</div>
        <div class="gcash-main">
          <div class="gcash-title">
            <strong>${esc(meta.label)}</strong>
            ${t.customerName ? `<span class="gcash-cust">· ${esc(t.customerName)}</span>` : ""}
          </div>
          <div class="gcash-meta">
            ${esc(date)}
            ${t.reference ? ` · Ref ${esc(t.reference)}` : ""}
            ${t.note ? ` · ${esc(t.note)}` : ""}
          </div>
        </div>
        <div class="gcash-amounts">
          <div class="gcash-amt ${isIn ? "in" : "out"}">${isIn ? "+" : "−"}${fmtMoney(t.amount)}</div>
          ${Number(t.fee) > 0 ? `<div class="gcash-fee">+${fmtMoney(t.fee)} fee</div>` : ""}
        </div>
        <div class="gcash-actions">
          <button type="button" class="sale-action-btn qr" onclick="openGcashPaymentQR('${t.id}')" title="Show Payment QR">📱</button>
          <button type="button" class="sale-action-btn receipt" onclick="printGcash('${t.id}')" title="Print slip">🖨️</button>
          <button type="button" class="sale-action-btn" onclick="editGcash('${t.id}')" title="Edit">✏️</button>
          <button type="button" class="sale-action-btn delete" onclick="deleteGcash('${t.id}')" title="Delete">🗑️</button>
        </div>
      </div>`;
  }).join("");
}

export function renderGcashPage() {
  renderGcashSummary();
  renderGcashList();
}

/* =========================================================
   PRINT SLIP
   ========================================================= */
export function printGcash(id) {
  const t = state.gcashTransactions.find(x => x.id === id);
  if (!t) { showToast("Transaction not found ❌"); return; }
  const meta = GCASH_TYPES[t.type] || GCASH_TYPES.other;
  const date = t.createdAt?.toDate?.().toLocaleString() || "—";
  printHTML(`
    <h1>GCash Transaction</h1>
    <div class="meta">${esc(CONSTANTS.STORE_NAME)} · ${esc(date)}</div>
    <table>
      <tr><th style="width:180px">Type</th><td>${esc(meta.label)}</td></tr>
      <tr><th>Amount</th><td>${fmtMoney(t.amount)}</td></tr>
      <tr><th>Service Fee</th><td>${fmtMoney(t.fee || 0)}</td></tr>
      ${t.customerName ? `<tr><th>Customer</th><td>${esc(t.customerName)}</td></tr>` : ""}
      ${t.reference ? `<tr><th>Reference #</th><td>${esc(t.reference)}</td></tr>` : ""}
      ${t.note ? `<tr><th>Note</th><td>${esc(t.note)}</td></tr>` : ""}
    </table>
  `, "GCash");
}
window.printGcash = printGcash;

/* =========================================================
   EXPORTS
   ========================================================= */
export function exportGcashExcel() {
  const list = getFilteredGcash();
  if (!list.length) { showToast("No GCash data to export ❌"); return; }
  const rows = list.map(t => {
    const meta = GCASH_TYPES[t.type] || GCASH_TYPES.other;
    return {
      Date: t.createdAt?.toDate?.().toLocaleString() ?? "",
      Type: meta.label,
      Customer: t.customerName || "",
      Reference: t.reference || "",
      "Amount (₱)": Number((Number(t.amount) || 0).toFixed(2)),
      "Fee (₱)": Number((Number(t.fee) || 0).toFixed(2)),
      Note: t.note || ""
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "GCash");
  downloadXLSX(wb, `gcash_${new Date().toISOString().slice(0,10)}.xlsx`);
  showToast("GCash exported ✅");
}

export function exportGcashPDF() {
  const list = getFilteredGcash();
  if (!list.length) { showToast("No GCash data to export ❌"); return; }
  if (!window.jspdf) { showToast("PDF library not loaded ❌"); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(16); doc.text("GCash Transactions", 14, 18);
  doc.setFontSize(10); doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 24);
  doc.autoTable({
    startY: 30,
    head: [["Date", "Type", "Customer", "Ref", "Amount", "Fee"]],
    body: list.map(t => {
      const meta = GCASH_TYPES[t.type] || GCASH_TYPES.other;
      return [
        t.createdAt?.toDate?.().toLocaleString() ?? "-",
        meta.label,
        t.customerName || "-",
        t.reference || "-",
        fmtMoney(t.amount, false),
        fmtMoney(t.fee || 0, false)
      ];
    }),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [18, 84, 79] }
  });
  downloadPDF(doc, `gcash_${new Date().toISOString().slice(0,10)}.pdf`);
  showToast("GCash PDF exported ✅");
}

/* =========================================================
   OPENING BALANCE PROMPT
   ========================================================= */
function promptOpeningBalance() {
  const cur = getOpeningBalance();
  const val = prompt("Set your GCash opening balance (₱):", cur || "0");
  if (val === null) return;
  const n = Number(val);
  if (isNaN(n)) { showToast("Invalid amount ❌"); return; }
  setOpeningBalance(n);
  showToast(`Opening balance set to ${fmtMoney(n)} ✅`);
  safeRender(renderGcashSummary);
}

/* =========================================================
   INIT + LISTENERS
   ========================================================= */
export function initGcash() {
  populateTypeSelect();
  wireGcashForm();
  wireGcashSettings();
  wireGcashPaymentModal();

  const filterType = $("gcash-filter-type");
  if (filterType) {
    filterType.innerHTML = `<option value="">All Types</option>` +
      Object.entries(GCASH_TYPES)
        .map(([k, v]) => `<option value="${k}">${v.icon} ${esc(v.label)}</option>`)
        .join("");
  }

  $("gcash-search")?.addEventListener("input", debounce(() => safeRender(renderGcashList), 150));
  $("gcash-filter-type")?.addEventListener("change", renderGcashList);
  $("gcash-filter-range")?.addEventListener("change", renderGcashList);
  $("gcash-export-excel")?.addEventListener("click", exportGcashExcel);
  $("gcash-export-pdf")?.addEventListener("click", exportGcashPDF);
  $("gcash-set-opening")?.addEventListener("click", promptOpeningBalance);
}

export function startGcashListeners(onAfter) {
  const wsId = myWorkspace();
  if (!wsId) return;
  state.unsubscribers.gcash = onSnapshot(
    query(collection(db, "gcash_transactions"), where("workspaceId", "==", wsId)),
    (snap) => {
      state.gcashTransactions = snap.docs
        .map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
        .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
      safeRender(renderGcashPage);
      onAfter?.();
    },
    (err) => console.error("[GCash listener]", err.code, err.message)
  );
}