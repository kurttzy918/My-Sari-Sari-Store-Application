/* utils.js — Helpers, formatters, sound, downloads, business helpers */
import { serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { state, CONSTANTS } from "./state.js";

/* -------- DOM -------- */
export const $ = (id) => document.getElementById(id);
export const valOf = (el) => (el ? String(el.value || "") : "");
export const numOf = (el) => (el ? (Number(el.value) || 0) : 0);
export const setVal = (el, v) => { if (el) el.value = v; };
export const esc = (str) => {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
};
export function debounce(fn, ms = 150) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function safeRender(fn) {
  try { if (typeof fn === "function") fn(); }
  catch (e) { console.error("[render] " + (fn?.name || "anon") + " failed:", e); }
}

/* -------- Formatters -------- */
export const fmtMoney = (n, withSymbol = true) => {
  const v = Number(n) || 0;
  const s = v.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return withSymbol ? "₱" + s : s;
};
export const fmtInt = (n) => (Number(n) || 0).toLocaleString("en-PH");
export const fmtShort = (n) => {
  const v = Number(n) || 0, abs = Math.abs(v);
  if (abs >= 1_000_000) return "₱" + (v / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000)     return "₱" + (v / 1_000).toFixed(2) + "K";
  return fmtMoney(v);
};
/* -------- Money rounding (IEEE-754 safety) -------- */
export const roundMoney = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
};
/* -------- Toast -------- */
const toastEl = () => document.getElementById("toast");
export function showToast(msg) {
  const t = toastEl();
  if (!t) return;
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add("hidden"), 3000);
}

/* -------- Sound -------- */
let audioCtx = null;
export function getAudioCtx() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx || audioCtx.state === "closed") audioCtx = new AC();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch { return null; }
}
document.addEventListener("pointerdown", getAudioCtx, { once: true });

export function playBeep(freq, dur, type = "sine") {
  if (!state.soundEnabled) return;
  const ctx = getAudioCtx(); if (!ctx) return;
  try {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    const t = ctx.currentTime;
    osc.type = type; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(t); osc.stop(t + dur);
    osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch {} };
  } catch {}
}
export const playSuccessSound = () => { playBeep(880, 0.12); setTimeout(() => playBeep(1100, 0.12), 120); };
export const playErrorSound   = () => playBeep(220, 0.35, "sawtooth");
export const playCashSound    = () => { playBeep(1320, 0.08); setTimeout(() => playBeep(1760, 0.08), 90); setTimeout(() => playBeep(2093, 0.16), 180); };

/* -------- Theme -------- */
export function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
  const themeIcon = document.getElementById("theme-icon");
  if (themeIcon) themeIcon.textContent = theme === "dark" ? "☀️" : "🌙";
}

/* -------- Workspace -------- */
export const myWorkspace = () => state.currentUser?.uid || null;

/* -------- Movement doc factory -------- */
export function movementDoc({ itemId, itemName, type, quantity, reason, note }) {
  return {
    workspaceId: myWorkspace(), itemId, itemName, type,
    quantity: Number(quantity),
    reason: reason || "other",
    note: note || "",
    userId: state.currentUser?.uid || null,
    createdAt: serverTimestamp()
  };
}

/* -------- Customer transaction doc factory -------- */
export function customerTxDoc({ customerId, customerName, type, amount, receiptNum, saleIds, note }) {
  return {
    workspaceId: myWorkspace(),
    customerId, customerName,
    type,                             // "purchase" | "payment"
    amount: Number(amount) || 0,
    receiptNum: receiptNum || "",
    saleIds: saleIds || [],
    note: note || "",
    userId: state.currentUser?.uid || null,
    createdAt: serverTimestamp()
  };
}

/* -------- Settle write (offline-aware) -------- */
export function settleWrite(promise, label = "Save") {
  const graceMs = navigator.onLine ? 3500 : 0;
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ pending: true }); } }, graceMs);
    promise.then(
      () => { if (!done) { done = true; clearTimeout(timer); resolve({ pending: false }); } },
      (err) => {
        console.error(`[${label}] write failed:`, err?.code, err?.message);
        if (!done) { done = true; clearTimeout(timer); reject(err); }
        else showToast(`${label} failed to sync: ${err?.code || err?.message} ❌`);
      }
    );
  });
}

/* -------- Downloads -------- */
export function downloadBlob(blob, filename) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.rel = "noopener"; a.style.display = "none";
    document.body.appendChild(a); a.click();
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch {}
      try { document.body.removeChild(a); } catch {}
    }, 1500);
  } catch (e) { console.error("[download]", e); showToast("Download failed ❌"); }
}
export function downloadXLSX(wb, filename) {
  if (typeof XLSX === "undefined") { showToast("Excel library not loaded ❌"); return; }
  try {
    const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    downloadBlob(blob, filename);
  } catch (e) { console.error("[xlsx]", e); showToast("Excel export failed ❌"); }
}
export function downloadPDF(doc, filename) {
  try { downloadBlob(doc.output("blob"), filename); }
  catch (e) { console.error("[pdf]", e); showToast("PDF export failed ❌"); }
}

/* -------- Generic print -------- */
export function printHTML(innerHTML, title = "Print") {
  try {
    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) { showToast("Allow popups to print 📄"); return; }
    w.document.write(`<!DOCTYPE html><html><head>
      <meta charset="utf-8" /><title>${esc(title)}</title>
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif;
               color: #111; padding: 20px; }
        h1 { font-size: 20px; color: #12544F; margin: 0 0 6px; }
        .meta { color: #666; font-size: 12px; margin-bottom: 14px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; font-size: 12px; }
        th { background: #12544F; color: #fff; }
        tr:nth-child(even) td { background: #f7fafb; }
      </style>
    </head><body>${innerHTML}</body></html>`);
    w.document.close(); w.focus();
    setTimeout(() => w.print(), 300);
  } catch (e) { console.error("[print]", e); showToast("Print failed ❌"); }
}

/* -------- Product visuals -------- */
export function fallbackColorFor(name) {
  const arr = CONSTANTS.FALLBACK_COLORS;
  return arr[((name || "").charCodeAt(0) || 0) % arr.length];
}
export function productImageHTML(item, size = "md") {
  const cls = size === "sm" ? "product-img sm" : "product-img";
  if (item.image) return `<img class="${cls}" src="${item.image}" alt="${esc(item.name)}" loading="lazy" />`;
  const initial = (item.name || "?").charAt(0).toUpperCase();
  return `<div class="${cls} fallback" style="background:${fallbackColorFor(item.name)}">${initial}</div>`;
}
export function thumbHTML(item) {
  if (item.image) return `<img src="${item.image}" alt="${esc(item.name)}" loading="lazy" />`;
  return esc((item.name || "?").charAt(0).toUpperCase());
}

/* -------- Expiry -------- */
export function parseExpiry(iso) {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}
export function daysUntilExpiry(iso) {
  const d = parseExpiry(iso);
  if (!d) return null;
  const now = new Date(); now.setHours(0,0,0,0);
  return Math.round((d - now) / (24 * 60 * 60 * 1000));
}
export function expiryStatus(iso) {
  const days = daysUntilExpiry(iso);
  if (days === null) return { level: "none", days: null, label: "" };
  if (days < 0)  return { level: "expired",  days, label: `Expired ${Math.abs(days)}d ago` };
  if (days === 0) return { level: "expired", days, label: "Expires today" };
  if (days <= CONSTANTS.EXPIRY_WARNING_DAYS) return { level: "expiring", days, label: `Expires in ${days}d` };
  const d = parseExpiry(iso);
  return { level: "ok", days, label: `Expires ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}` };
}

/* -------- Sales data helpers -------- */
export function getSoldMap() {
  const map = {};
  state.sales.forEach(s => { if (s.itemId) map[s.itemId] = (map[s.itemId] || 0) + (s.quantity || 0); });
  return map;
}
export function getSoldMapLastDays(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const map = {};
  state.sales.forEach(s => {
    const ms = s.createdAt?.toMillis?.() ?? 0;
    if (ms < cutoff) return;
    if (s.itemId) map[s.itemId] = (map[s.itemId] || 0) + (s.quantity || 0);
  });
  return map;
}
export function getFastSellingInfo(itemId, totalSold) {
  const { minTotalSold, lookbackDays, minPerDay } = CONSTANTS.FAST_SELLING;
  const total = Number(totalSold) || 0;
  if (total <= minTotalSold) return { isFast: false, total, perDay: 0, recent: 0 };
  const recent = getSoldMapLastDays(lookbackDays)[itemId] || 0;
  const perDay = recent / lookbackDays;
  return { isFast: perDay >= minPerDay, total, perDay, recent };
}
export function getSalesByCategory(list = state.sales) {
  const map = {};
  list.forEach(s => {
    const cat = (s.category || "Uncategorized").trim() || "Uncategorized";
    if (!map[cat]) map[cat] = { total: 0, count: 0, qty: 0 };
    map[cat].total += Number(s.total) || 0;
    map[cat].count += 1;
    map[cat].qty   += Number(s.quantity) || 0;
  });
  return map;
}

/* -------- Date helpers -------- */
export function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
export function monthLabel(key) {
  if (!key) return "All Time";
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/* -------- CSS var read -------- */
export const getCSSVar = (n) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* -------- Barcode / SKU lookup --------
   Pure lookup against the live inventory cache.
   Barcodes are always handled as strings to preserve
   leading zeros and special characters. */
export function findItemByCode(code) {
  if (!code) return null;
  const norm = String(code).trim().replace(/\s+/g, "");
  if (!norm) return null;
  const lower = norm.toLowerCase();

  // 1) Exact barcode match
  let item = state.inventory.find(i => i.barcode && String(i.barcode).trim() === norm);
  if (item) return item;
  item = state.inventory.find(i => i.barcode && String(i.barcode).trim().toLowerCase() === lower);
  if (item) return item;

  // 2) Exact SKU match
  item = state.inventory.find(i => i.sku && String(i.sku).trim() === norm);
  if (item) return item;
  item = state.inventory.find(i => i.sku && String(i.sku).trim().toLowerCase() === lower);
  if (item) return item;

  // 3) Loose partial match (last resort)
  return state.inventory.find(i =>
    (i.barcode && String(i.barcode).trim().toLowerCase().includes(lower)) ||
    (i.sku && String(i.sku).trim().toLowerCase().includes(lower))
  ) || null;
}
/* =========================================================
   STORE DISPLAY NAME — pulls from the logged-in account
   Priority: manual override → Google display name
            → first name from email → fallback
   ========================================================= */
export function getStoreDisplayName() {
  // 1) Manual override (set via the receipt click or console)
  try {
    const override = localStorage.getItem("storeDisplayName");
    if (override && override.trim()) return override.trim();
  } catch {}

  // 2) Google display name (state.currentUser or user data doc)
  const user = state.currentUser;
  const data = state.currentUserData || {};
  const dn = user?.displayName || data.displayName;
  if (dn && String(dn).trim()) return String(dn).trim();

  // 3) First name from email
  const email = user?.email || data.email || "";
  if (email) {
    const local = email.split("@")[0] || "";
    const clean = local.split(/[._\-+0-9]/)[0] || local;
    if (clean) return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
  }

  // 4) Fallback
  return "My Sari-Sari Store";
}

/* ---------- Optional: let users rename their store ---------- */
export function setStoreDisplayName(name) {
  try {
    const clean = String(name || "").trim();
    if (clean) localStorage.setItem("storeDisplayName", clean);
    else localStorage.removeItem("storeDisplayName");
    return true;
  } catch { return false; }
}

/* ---------- Interactive: prompt-based rename ---------- */
export function promptStoreRename() {
  const current = getStoreDisplayName();
  const next = prompt("Enter your store name (shown on receipts):", current);
  if (next === null) return;
  const clean = next.trim();
  if (!clean) {
    try { localStorage.removeItem("storeDisplayName"); } catch {}
    showToast("Store name reset to account default ✅");
  } else {
    try { localStorage.setItem("storeDisplayName", clean); } catch {}
    showToast(`Store name set to "${clean}" ✅`);
  }
}
/* =========================================================
   EXPENSE HELPERS — for net profit calculation
   ========================================================= */

/* Sum expenses, optionally filtered by a time window.
   opts.since → ms (inclusive), opts.until → ms (exclusive) */
export function getTotalExpenses(opts = {}) {
  const { since, until } = opts;
  let total = 0;
  (state.expenses || []).forEach(e => {
    const amt = Number(e.amount) || 0;
    if (since || until) {
      const ms = e.date
        ? new Date(e.date + "T00:00:00").getTime()
        : (e.createdAt?.toMillis?.() ?? 0);
      if (since != null && ms < since) return;
      if (until != null && ms >= until) return;
    }
    total += amt;
  });
  return roundMoney(total);
}

/* Gross profit = sum of sales.profit (before expenses) */
export function getGrossProfit() {
  return roundMoney(
    (state.sales || []).reduce((s, x) => s + (Number(x.profit) || 0), 0)
  );
}

/* Net profit = gross profit − all-time expenses */
export function getNetProfit() {
  return roundMoney(getGrossProfit() - getTotalExpenses());
}

/* Expenses for the current calendar month */
export function getMonthExpenses() {
  const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
  return getTotalExpenses({ since: d.getTime() });
}

/* Same window helper for today */
export function getTodayExpenses() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return getTotalExpenses({ since: d.getTime(), until: d.getTime() + 86400000 });
}