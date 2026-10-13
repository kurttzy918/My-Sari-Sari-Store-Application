/* maya.js — Pay Maya tracker (twin of gcash.js) */
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc,
  serverTimestamp, query, where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { state } from "./state.js";
import {
  $, valOf, esc, debounce, safeRender, showToast,
  myWorkspace, settleWrite, fmtInt, fmtMoney,
  downloadXLSX, downloadPDF
} from "./utils.js";

/* =========================================================
   LOCAL STATE
   ========================================================= */
const mayaState = {
  initialized: false,
  editingId: null,
  settings: { number: "", accountName: "" },
  filterType: "",
  filterRange: "",
  search: ""
};

/* =========================================================
   SETTINGS (LocalStorage)
   ========================================================= */
function loadMayaSettings() {
  try {
    const raw = localStorage.getItem("mayaSettings");
    if (raw) mayaState.settings = JSON.parse(raw);
  } catch {}
  if ($("maya-number")) $("maya-number").value = mayaState.settings.number || "";
  if ($("maya-account-name")) $("maya-account-name").value = mayaState.settings.accountName || "";
}

function saveMayaSettings() {
  mayaState.settings = {
    number: valOf($("maya-number")).trim(),
    accountName: valOf($("maya-account-name")).trim()
  };
  try { localStorage.setItem("mayaSettings", JSON.stringify(mayaState.settings)); } catch {}
  showToast("Pay Maya settings saved ✅");
  renderMayaQR();
}

/* =========================================================
   QR CODE
   ========================================================= */
function renderMayaQR() {
  const canvas = $("maya-settings-canvas");
  if (!canvas) return;
  const retryBtn = $("maya-qr-retry");
  
  if (typeof window.QRCode === "undefined") {
    retryBtn?.classList.remove("hidden");
    return;
  }
  retryBtn?.classList.add("hidden");

  const payload = JSON.stringify({
    type: "maya",
    number: mayaState.settings.number,
    name: mayaState.settings.accountName
  });

  try {
    window.QRCode.toCanvas(canvas, payload, { width: 180, margin: 1 }, (err) => {
      if (err) console.warn("[maya QR]", err);
    });
  } catch (e) {
    console.warn("[maya QR] failed:", e);
  }
}

/* =========================================================
   RENDER — Summary
   ========================================================= */
function renderMayaSummary() {
  const txns = state.mayaTransactions || [];
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  let inToday = 0, outToday = 0, feeToday = 0, inCount = 0, outCount = 0;
  let feeMonth = 0, balance = 0;

  txns.forEach(t => {
    const ms = t.createdAt?.toMillis?.() ?? 0;
    const amt = Number(t.amount) || 0;
    const fee = Number(t.fee) || 0;

    if (t.type === "in") balance += amt;
    else if (t.type === "out") balance -= amt;
    balance += fee; // Fees are income

    if (ms >= todayStart) {
      if (t.type === "in") { inToday += amt; inCount++; }
      if (t.type === "out") { outToday += amt; outCount++; }
      feeToday += fee;
    }

    const tDate = t.createdAt?.toDate?.();
    if (tDate && tDate.getMonth() === now.getMonth() && tDate.getFullYear() === now.getFullYear()) {
      feeMonth += fee;
    }
  });

  if ($("maya-in-today")) $("maya-in-today").textContent = fmtMoney(inToday);
  if ($("maya-out-today")) $("maya-out-today").textContent = fmtMoney(outToday);
  if ($("maya-fee-today")) $("maya-fee-today").textContent = fmtMoney(feeToday);
  if ($("maya-balance")) $("maya-balance").textContent = fmtMoney(balance);
  if ($("maya-in-count")) $("maya-in-count").textContent = `${inCount} transactions`;
  if ($("maya-out-count")) $("maya-out-count").textContent = `${outCount} transactions`;
  if ($("maya-fee-month")) $("maya-fee-month").textContent = `This month: ${fmtMoney(feeMonth)}`;
}

/* =========================================================
   RENDER — List
   ========================================================= */
function renderMayaList() {
  const list = $("maya-list");
  if (!list) return;

  let txns = (state.mayaTransactions || []).slice();

  /* Filters */
  if (mayaState.filterType) txns = txns.filter(t => t.type === mayaState.filterType);
  if (mayaState.search) {
    const term = mayaState.search.toLowerCase();
    txns = txns.filter(t =>
      (t.customer || "").toLowerCase().includes(term) ||
      (t.reference || "").toLowerCase().includes(term) ||
      (t.note || "").toLowerCase().includes(term)
    );
  }
  if (mayaState.filterRange) {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    let cutoff = 0;
    if (mayaState.filterRange === "today") {
      const d = new Date(); d.setHours(0,0,0,0); cutoff = d.getTime();
    } else if (mayaState.filterRange === "7") cutoff = now - 7 * dayMs;
    else if (mayaState.filterRange === "30") cutoff = now - 30 * dayMs;
    txns = txns.filter(t => (t.createdAt?.toMillis?.() ?? 0) >= cutoff);
  }

  if (!txns.length) {
    list.innerHTML = `<div class="empty-state"><p>📭 No Pay Maya transactions yet.</p></div>`;
    return;
  }

  list.innerHTML = txns.slice(0, 100).map(t => {
    const isIn = t.type === "in";
    const date = t.createdAt?.toDate?.().toLocaleString() || "—";
    return `
      <div class="maya-row">
        <div class="maya-icon ${isIn ? "in" : "out"}">${isIn ? "⬇️" : "⬆️"}</div>
        <div class="maya-main">
          <div class="maya-title">${isIn ? "Cash In" : "Cash Out"}${t.customer ? ` · ${esc(t.customer)}` : ""}</div>
          <div class="maya-meta">${date}${t.reference ? " · Ref: " + esc(t.reference) : ""}${t.note ? " · " + esc(t.note) : ""}</div>
        </div>
        <div class="maya-amounts">
          <div class="maya-amt ${isIn ? "in" : "out"}">${isIn ? "+" : "−"}${fmtMoney(t.amount)}</div>
          ${t.fee ? `<div class="maya-fee">Fee: ${fmtMoney(t.fee)}</div>` : ""}
        </div>
        <div class="maya-actions">
          <button type="button" class="sale-action-btn" onclick="editMaya('${t.id}')" title="Edit">✏️</button>
          <button type="button" class="sale-action-btn delete" onclick="deleteMaya('${t.id}')" title="Delete">🗑️</button>
        </div>
      </div>
    `;
  }).join("");
}

/* =========================================================
   CRUD
   ========================================================= */
function wireMayaForm() {
  const form = $("maya-form");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const wsId = myWorkspace();
    if (!wsId) { showToast("Workspace not ready ❌"); return; }

    const amount = Number(valOf($("maya-amount")));
    if (!amount || amount <= 0) { showToast("Enter a valid amount ❌"); return; }

    const data = {
      type: valOf($("maya-type")) || "in",
      amount,
      fee: Number(valOf($("maya-fee"))) || 0,
      customer: valOf($("maya-customer")).trim(),
      reference: valOf($("maya-reference")).trim(),
      note: valOf($("maya-note")).trim(),
      workspaceId: wsId,
      updatedAt: serverTimestamp()
    };

    try {
      if (mayaState.editingId) {
        await updateDoc(doc(db, "maya_transactions", mayaState.editingId), data);
        showToast("Transaction updated ✅");
      } else {
        await addDoc(collection(db, "maya_transactions"), { ...data, createdAt: serverTimestamp() });
        showToast("Transaction saved ✅");
      }
      form.reset();
      if ($("maya-id")) $("maya-id").value = "";
      if ($("maya-form-title")) $("maya-form-title").textContent = "Record Pay Maya Transaction";
      mayaState.editingId = null;
      $("maya-cancel-edit")?.classList.add("hidden");
    } catch (err) {
      showToast(`Failed: ${err.code || err.message} ❌`);
    }
  });
}

export function editMaya(id) {
  const t = state.mayaTransactions.find(x => x.id === id);
  if (!t) return;
  mayaState.editingId = id;
  if ($("maya-id")) $("maya-id").value = id;
  if ($("maya-type")) $("maya-type").value = t.type;
  if ($("maya-amount")) $("maya-amount").value = t.amount;
  if ($("maya-fee")) $("maya-fee").value = t.fee || 0;
  if ($("maya-customer")) $("maya-customer").value = t.customer || "";
  if ($("maya-reference")) $("maya-reference").value = t.reference || "";
  if ($("maya-note")) $("maya-note").value = t.note || "";
  if ($("maya-form-title")) $("maya-form-title").textContent = "Edit Pay Maya Transaction";
  $("maya-cancel-edit")?.classList.remove("hidden");
  $("maya-form")?.scrollIntoView({ behavior: "smooth" });
}
window.editMaya = editMaya;

export async function deleteMaya(id) {
  if (!confirm("Delete this transaction?")) return;
  try {
    await deleteDoc(doc(db, "maya_transactions", id));
    showToast("Transaction deleted 🗑️");
  } catch (err) {
    showToast(`Failed: ${err.code || err.message} ❌`);
  }
}
window.deleteMaya = deleteMaya;

/* =========================================================
   EXPORTS
   ========================================================= */
function exportMayaExcel() {
  if (!state.mayaTransactions.length) { showToast("No transactions ❌"); return; }
  const data = state.mayaTransactions.map(t => ({
    Date: t.createdAt?.toDate?.().toLocaleString() || "",
    Type: t.type === "in" ? "Cash In" : "Cash Out",
    Amount: t.amount,
    Fee: t.fee || 0,
    Customer: t.customer || "",
    Reference: t.reference || "",
    Note: t.note || ""
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Maya");
  downloadXLSX(wb, `maya_${new Date().toISOString().slice(0,10)}.xlsx`);
  showToast("Excel exported ✅");
}

function exportMayaPDF() {
  if (!state.mayaTransactions.length) { showToast("No transactions ❌"); return; }
  if (!window.jspdf) { showToast("PDF library not loaded ❌"); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(16); doc.text("Pay Maya Transactions", 14, 18);
  doc.setFontSize(10); doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 24);
  doc.autoTable({
    startY: 30,
    head: [["Date", "Type", "Amount", "Fee", "Customer", "Reference"]],
    body: state.mayaTransactions.map(t => [
      t.createdAt?.toDate?.().toLocaleString() || "-",
      t.type === "in" ? "Cash In" : "Cash Out",
      fmtMoney(t.amount, false),
      fmtMoney(t.fee || 0, false),
      t.customer || "-",
      t.reference || "-"
    ]),
    styles: { fontSize: 8 }, headStyles: { fillColor: [11, 111, 222] }
  });
  downloadPDF(doc, `maya_${new Date().toISOString().slice(0,10)}.pdf`);
  showToast("PDF exported ✅");
}

/* =========================================================
   INIT + LISTENERS
   ========================================================= */
export function initMaya() {
  if (mayaState.initialized) return;
  mayaState.initialized = true;

  loadMayaSettings();
  renderMayaQR();

  /* Settings */
  $("maya-save-settings")?.addEventListener("click", saveMayaSettings);
  $("maya-qr-retry")?.addEventListener("click", () => {
    if (typeof window.QRCode === "undefined") {
      showToast("Loading QR library...");
      setTimeout(renderMayaQR, 1000);
    } else {
      renderMayaQR();
    }
  });

  /* Set Opening Balance */
  $("maya-set-opening")?.addEventListener("click", () => {
    const val = prompt("Enter opening balance (₱):");
    if (val === null) return;
    const num = Number(val);
    if (isNaN(num)) { showToast("Invalid amount ❌"); return; }
    if ($("maya-balance")) $("maya-balance").textContent = fmtMoney(num);
    showToast("Opening balance set ✅");
  });

  /* Form */
  wireMayaForm();
  $("maya-cancel-edit")?.addEventListener("click", () => {
    mayaState.editingId = null;
    $("maya-form")?.reset();
    if ($("maya-id")) $("maya-id").value = "";
    if ($("maya-form-title")) $("maya-form-title").textContent = "Record Pay Maya Transaction";
    $("maya-cancel-edit")?.classList.add("hidden");
  });

  /* Filters */
  $("maya-search")?.addEventListener("input", debounce((e) => {
    mayaState.search = e.target.value || "";
    renderMayaList();
  }, 150));

  $("maya-filter-type")?.addEventListener("change", (e) => {
    mayaState.filterType = e.target.value;
    renderMayaList();
  });

  $("maya-filter-range")?.addEventListener("change", (e) => {
    mayaState.filterRange = e.target.value;
    renderMayaList();
  });

  /* Export */
  $("maya-export-excel")?.addEventListener("click", exportMayaExcel);
  $("maya-export-pdf")?.addEventListener("click", exportMayaPDF);

  /* Populate type select */
  const typeSel = $("maya-type");
  if (typeSel && !typeSel.options.length) {
    typeSel.innerHTML = `
      <option value="in">⬇️ Cash In</option>
      <option value="out">⬆️ Cash Out</option>
    `;
  }
  const filterSel = $("maya-filter-type");
  if (filterSel && filterSel.options.length <= 1) {
    filterSel.innerHTML = `
      <option value="">All Types</option>
      <option value="in">⬇️ Cash In</option>
      <option value="out">⬆️ Cash Out</option>
    `;
  }
}

export function renderMayaPage() {
  renderMayaSummary();
  renderMayaList();
  renderMayaQR();
}

export function startMayaListeners(onAfter) {
  const wsId = myWorkspace();
  if (!wsId) return;

  state.unsubscribers.maya = onSnapshot(
    query(collection(db, "maya_transactions"), where("workspaceId", "==", wsId)),
    (snap) => {
      state.mayaTransactions = snap.docs
        .map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
        .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
      
      safeRender(renderMayaSummary);
      safeRender(renderMayaList);
      onAfter?.();
    },
    (err) => console.error("[Maya listener]", err.code, err.message)
  );
}