/* eload.js — E-Load (prepaid credits) selling tracker */
import {
  collection, onSnapshot, addDoc, deleteDoc, doc,
  serverTimestamp, query, where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { state, CONSTANTS } from "./state.js";
import {
  $, valOf, esc, debounce, safeRender, showToast,
  myWorkspace, playSuccessSound, playErrorSound,
  fmtInt, fmtMoney, downloadXLSX, downloadPDF, printHTML,
  getStoreDisplayName
} from "./utils.js";

/* =========================================================
   DEFAULT NETWORKS  (serviceFee % replaces discount)
   ========================================================= */
const DEFAULT_NETWORKS = [
  { id: "smart",  name: "Smart",  emoji: "📶", color: "#E60000", serviceFee: 4 },
  { id: "globe",  name: "Globe",  emoji: "📶", color: "#0072BC", serviceFee: 4 },
  { id: "tm",     name: "TM",     emoji: "📶", color: "#00A651", serviceFee: 4 },
  { id: "tnt",    name: "TNT",    emoji: "📶", color: "#FFCC00", serviceFee: 4 },
  { id: "dito",   name: "DITO",   emoji: "📶", color: "#00B2E3", serviceFee: 5 },
  { id: "cignal", name: "Cignal", emoji: "📡", color: "#7CBE41", serviceFee: 5 },
  { id: "gomo",   name: "GOMO",   emoji: "📶", color: "#F5A623", serviceFee: 4 }
];

const AMOUNT_PRESETS = [10, 15, 20, 25, 30, 50, 100, 200, 300, 500];

const NETWORKS_KEY = (ws) => `eloadNetworks:${ws}`;
const WALLET_KEY   = (ws) => `eloadWallet:${ws}`;

/* =========================================================
   NETWORK CONFIG  (with backward compatibility)
   ========================================================= */
function loadNetworks() {
  const ws = myWorkspace(); if (!ws) return DEFAULT_NETWORKS.slice();
  try {
    const raw = localStorage.getItem(NETWORKS_KEY(ws));
    if (!raw) return DEFAULT_NETWORKS.slice();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) {
      return DEFAULT_NETWORKS.map(def => {
        const saved = parsed.find(p => p.id === def.id);
        if (!saved) return def;
        // Support legacy "discount" key from old installs
        const fee = saved.serviceFee ?? saved.discount ?? def.serviceFee;
        return { ...def, serviceFee: Number(fee) || def.serviceFee };
      });
    }
  } catch {}
  return DEFAULT_NETWORKS.slice();
}

function saveNetworks(networks) {
  const ws = myWorkspace(); if (!ws) return;
  try {
    localStorage.setItem(NETWORKS_KEY(ws), JSON.stringify(
      networks.map(n => ({ id: n.id, serviceFee: n.serviceFee }))
    ));
  } catch {}
}

/* =========================================================
   WALLET
   ========================================================= */
function loadWallet() {
  const ws = myWorkspace();
  if (!ws) return { balance: 0, lastTopUp: 0, lastTopUpAmount: 0 };
  try {
    const raw = localStorage.getItem(WALLET_KEY(ws));
    if (raw) {
      const p = JSON.parse(raw);
      return {
        balance:           Number(p.balance) || 0,
        lastTopUp:         Number(p.lastTopUp) || 0,
        lastTopUpAmount:   Number(p.lastTopUpAmount) || 0
      };
    }
  } catch {}
  return { balance: 0, lastTopUp: 0, lastTopUpAmount: 0 };
}
function saveWallet(w) {
  const ws = myWorkspace(); if (!ws) return;
  try { localStorage.setItem(WALLET_KEY(ws), JSON.stringify(w)); } catch {}
}
function addToWallet(amount) {
  const w = loadWallet();
  w.balance += Number(amount) || 0;
  w.lastTopUp = Date.now();
  w.lastTopUpAmount = Number(amount) || 0;
  saveWallet(w);
  return w;
}
function deductFromWallet(amount) {
  const w = loadWallet();
  w.balance = Math.max(0, w.balance - (Number(amount) || 0));
  saveWallet(w);
  return w;
}
function resetWallet() {
  saveWallet({ balance: 0, lastTopUp: 0, lastTopUpAmount: 0 });
}

/* =========================================================
   LOCAL STATE
   ========================================================= */
const _sel = { networkId: null, amount: 0, customMode: false };

/* =========================================================
   PHONE HELPERS
   ========================================================= */
function normalizePhone(input) {
  let s = String(input || "").replace(/[^\d+]/g, "");
  if (s.startsWith("+63")) s = "0" + s.slice(3);
  if (s.startsWith("63") && s.length === 12) s = "0" + s.slice(2);
  if (/^9\d{9}$/.test(s)) s = "0" + s;
  return s.slice(0, 11);
}
function isValidPhPhone(s) { return /^09\d{9}$/.test(s); }
function prettyPhone(s) {
  if (!/^09\d{9}$/.test(s)) return s;
  return `${s.slice(0, 4)} ${s.slice(4, 7)} ${s.slice(7)}`;
}

/* =========================================================
   COST / PROFIT — serviceFee replaces discount
   ========================================================= */
function getNetwork(id) {
  return loadNetworks().find(n => n.id === id) || DEFAULT_NETWORKS[0];
}

function computeCostProfit(networkId, amount) {
  const net = getNetwork(networkId);
  const amt = Number(amount) || 0;
  const feePct = Number(net.serviceFee) || 0;
  const cost = Math.round(amt * (1 - feePct / 100) * 100) / 100;
  const profit = Math.round((amt - cost) * 100) / 100;
  return { cost, profit, feePct, network: net, amount: amt };
}

/* =========================================================
   RENDER — Network Buttons
   ========================================================= */
function renderNetworkGrid() {
  const grid = $("eload-network-grid"); if (!grid) return;
  const nets = loadNetworks();
  grid.innerHTML = nets.map(n => `
    <button type="button"
            class="eload-net-btn ${_sel.networkId === n.id ? "is-active" : ""}"
            data-net="${n.id}"
            style="--net-color: ${n.color}">
      <span class="eload-net-emoji">${n.emoji}</span>
      <span class="eload-net-name">${esc(n.name)}</span>
      <span class="eload-net-disc">₱${Number(n.serviceFee).toFixed(2)}/100</span>
    </button>
  `).join("");

  grid.querySelectorAll(".eload-net-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      _sel.networkId = btn.dataset.net;
      renderNetworkGrid();
      renderAmountGrid();
      updateSellPreview();
    });
  });
}

/* =========================================================
   RENDER — Amount Buttons
   ========================================================= */
function renderAmountGrid() {
  const grid = $("eload-amount-grid"); if (!grid) return;
  const net = _sel.networkId ? getNetwork(_sel.networkId) : null;

  grid.innerHTML = AMOUNT_PRESETS.map(amt => {
    const isActive = !_sel.customMode && _sel.amount === amt;
    let profitHTML = "";
    if (net) {
      const { profit } = computeCostProfit(_sel.networkId, amt);
      profitHTML = `<span class="eload-amt-profit">+${fmtMoney(profit)}</span>`;
    }
    return `
      <button type="button" class="eload-amt-btn ${isActive ? "is-active" : ""}" data-amt="${amt}">
        <span class="eload-amt-value">₱${fmtInt(amt)}</span>
        ${profitHTML}
      </button>
    `;
  }).join("");

  grid.querySelectorAll(".eload-amt-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      _sel.amount = Number(btn.dataset.amt);
      _sel.customMode = false;
      $("eload-custom-row")?.classList.add("hidden");
      renderAmountGrid();
      updateSellPreview();
    });
  });
}

/* =========================================================
   RENDER — Live Sell Preview
   ========================================================= */
function updateSellPreview() {
  const preview = $("eload-preview");
  const sellBtn = $("eload-sell-btn");
  if (!preview || !sellBtn) return;

  const hasNet = !!_sel.networkId;
  const hasAmount = _sel.amount > 0;
  const phone = normalizePhone(valOf($("eload-phone")));
  const phoneOK = isValidPhPhone(phone);

  if (!hasNet || !hasAmount) {
    preview.innerHTML = `<div class="eload-preview-empty">Select network & amount to see the breakdown</div>`;
    sellBtn.disabled = true;
    updateSellHint();
    return;
  }

  const { cost, profit, feePct, network } = computeCostProfit(_sel.networkId, _sel.amount);
  const wallet = loadWallet();
  const walletOK = wallet.balance >= cost;
  const walletAfter = Math.max(0, wallet.balance - cost);

  preview.innerHTML = `
    <div class="eload-preview-grid">
      <div class="eload-preview-row">
        <span>Network</span>
        <strong style="color:${network.color}">${esc(network.name)}</strong>
      </div>
      <div class="eload-preview-row">
        <span>Face Value</span>
        <strong>${fmtMoney(_sel.amount)}</strong>
      </div>
      <div class="eload-preview-row">
      <span>Service Fee</span>
    <strong class="eload-cost">+ ${fmtMoney(_sel.amount - cost)}</strong>
      </div>
      <div class="eload-preview-divider"></div>
      <div class="eload-preview-row highlight">
        <span>Your Cost</span>
        <strong>${fmtMoney(cost)}</strong>
      </div>
      <div class="eload-preview-row highlight-profit">
        <span>Your Profit</span>
        <strong>+ ${fmtMoney(profit)}</strong>
      </div>
      <div class="eload-preview-divider"></div>
      <div class="eload-preview-row">
        <span>Wallet After</span>
        <strong class="${walletOK ? "" : "eload-warn"}">
          ${fmtMoney(walletAfter)}${walletOK ? "" : " ⚠️"}
        </strong>
      </div>
      ${phone ? `
        <div class="eload-preview-row">
          <span>Phone</span>
          <strong class="${phoneOK ? "eload-ok" : "eload-warn"} mono">
            ${esc(phone)}${phoneOK ? "" : " ⚠️ invalid"}
          </strong>
        </div>` : ""}
    </div>
  `;

  sellBtn.disabled = !phoneOK || !walletOK;
  if (!phoneOK)        sellBtn.textContent = "📱 Enter a valid number";
  else if (!walletOK)  sellBtn.textContent = "💼 Not enough wallet balance";
  else                 sellBtn.textContent = `💰 Sell ₱${fmtInt(_sel.amount)} Load`;

  updateSellHint();
}

function updateSellHint() {
  const hint = $("eload-sell-hint");
  if (!hint) return;
  const hasNet = !!_sel.networkId;
  const hasAmount = _sel.amount > 0;
  const phone = normalizePhone(valOf($("eload-phone")));
  const phoneOK = isValidPhPhone(phone);

  if (!hasNet)         hint.textContent = "Step 1: pick a network";
  else if (!hasAmount) hint.textContent = "Step 2: pick an amount";
  else if (!phoneOK)   hint.textContent = "Step 3: enter customer number";
  else                 hint.textContent = "Ready to sell ✓";
}

/* =========================================================
   RENDER — Service Fee Settings
   ========================================================= */
function renderNetworkSettings() {
  const container = $("eload-network-settings"); if (!container) return;
  const nets = loadNetworks();

  container.innerHTML = nets.map(n => `
    <div class="eload-net-setting-row">
      <div class="eload-net-setting-info">
        <span class="eload-net-dot" style="background:${n.color}"></span>
        <span class="eload-net-setting-name">${esc(n.name)}</span>
      </div>
      <div class="eload-net-setting-input">
        <input type="number"
               min="0" max="30" step="0.1"
               value="${Number(n.serviceFee).toFixed(1)}"
               data-net-id="${n.id}"
               class="eload-net-disc-input"
               aria-label="${esc(n.name)} service fee %" />
        <span class="eload-net-pct">%</span>
      </div>
    </div>
  `).join("");
}

function wireNetworkSettingsSave() {
  $("eload-save-network-settings")?.addEventListener("click", () => {
    const inputs = document.querySelectorAll(".eload-net-disc-input");
    const nets = loadNetworks();
    inputs.forEach(inp => {
      const id = inp.dataset.netId;
      const val = Number(inp.value);
      if (!isNaN(val) && val >= 0 && val <= 30) {
        const net = nets.find(n => n.id === id);
        if (net) net.serviceFee = val;
      }
    });
    saveNetworks(nets);
    playSuccessSound();
    showToast("Service fees saved ✅");
    renderNetworkGrid();
    renderAmountGrid();
    updateSellPreview();
  });
}

/* =========================================================
   WALLET UI
   ========================================================= */
function renderWalletUI() {
  const w = loadWallet();
  const txt = fmtMoney(w.balance);
  const setTxt = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  setTxt("eload-wallet-balance", txt);
  setTxt("eload-wallet-display", txt);

  const meta = $("eload-wallet-meta");
  if (meta) {
    if (!w.lastTopUp) meta.textContent = "No top-ups yet";
    else {
      const ago = Math.floor((Date.now() - w.lastTopUp) / 60000);
      const when = ago < 1 ? "just now"
                 : ago < 60 ? `${ago}m ago`
                 : ago < 1440 ? `${Math.floor(ago/60)}h ago`
                 : `${Math.floor(ago/1440)}d ago`;
      meta.textContent = `Last top-up: ${fmtMoney(w.lastTopUpAmount)} · ${when}`;
    }
  }
}

/* =========================================================
   SUMMARY
   ========================================================= */
function getTodayBounds() {
  const t = new Date(); t.setHours(0,0,0,0);
  return { start: t.getTime(), end: t.getTime() + 86400000 };
}
function getMonthStart() {
  const d = new Date(); d.setDate(1); d.setHours(0,0,0,0);
  return d.getTime();
}

function renderEloadSummary() {
  const { start, end } = getTodayBounds();
  const monthStart = getMonthStart();

  let salesToday = 0, profitToday = 0, countToday = 0;
  let profitMonth = 0, totalAmount = 0, totalProfit = 0, totalCount = 0;

  state.eloadTransactions.forEach(t => {
    const ms = t.createdAt?.toMillis?.() ?? 0;
    const amt = Number(t.amount) || 0;
    const pf  = Number(t.profit) || 0;

    totalAmount += amt; totalProfit += pf; totalCount++;

    if (ms >= start && ms < end) { salesToday += amt; profitToday += pf; countToday++; }
    if (ms >= monthStart) profitMonth += pf;
  });

  const setTxt = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  setTxt("eload-sales-today",   fmtMoney(salesToday));
  setTxt("eload-profit-today",  fmtMoney(profitToday));
  setTxt("eload-profit-month",  `This month: ${fmtMoney(profitMonth)}`);
  setTxt("eload-sales-count",   `${fmtInt(countToday)} transaction${countToday !== 1 ? "s" : ""}`);

  const avgMargin = totalAmount > 0 ? (totalProfit / totalAmount) * 100 : 0;
  const avgAmount = totalCount > 0 ? totalAmount / totalCount : 0;
  setTxt("eload-avg-margin", avgMargin.toFixed(1) + "%");
  setTxt("eload-avg-amount", `Avg load: ${fmtMoney(avgAmount)}`);

  renderWalletUI();
}

/* =========================================================
   SELL LOAD
   ========================================================= */
async function handleSellLoad() {
  const wsId = myWorkspace();
  if (!wsId) { showToast("Workspace not ready ❌"); return; }

  const phone = normalizePhone(valOf($("eload-phone")));
  if (!isValidPhPhone(phone)) {
    playErrorSound(); showToast("Enter a valid PH number (09XXXXXXXXX) ❌"); return;
  }
  if (!_sel.networkId || !_sel.amount) {
    playErrorSound(); showToast("Select network and amount ❌"); return;
  }

  const { cost, profit, feePct, network } = computeCostProfit(_sel.networkId, _sel.amount);
  const wallet = loadWallet();
  if (wallet.balance < cost) {
    playErrorSound(); showToast(`Not enough wallet balance. Need ${fmtMoney(cost)} ❌`); return;
  }

  const customerName = valOf($("eload-customer")).trim();
  const receiptNum = `LD-${Date.now().toString(36).toUpperCase().slice(-7)}`;
  const btn = $("eload-sell-btn"); if (btn) btn.disabled = true;

  try {
    await addDoc(collection(db, "eload_transactions"), {
      workspaceId: wsId,
      network: network.name,
      networkId: network.id,
      phone,
      amount: _sel.amount,
      cost,
      profit,
      serviceFee: feePct,
      customerName: customerName || null,
      receiptNum,
      createdAt: serverTimestamp(),
      userId: state.currentUser?.uid || null
    });

    deductFromWallet(cost);
    renderWalletUI();

    playSuccessSound();
    showToast(`Sold ₱${fmtInt(_sel.amount)} ${network.name} · +${fmtMoney(profit)} ✅`);

    showSaleConfirmation({
      network, phone, amount: _sel.amount, cost, profit, customerName, receiptNum, feePct
    });

    _sel.amount = 0; _sel.customMode = false;
    if ($("eload-phone")) $("eload-phone").value = "";
    if ($("eload-customer")) $("eload-customer").value = "";
    if ($("eload-custom-amount")) $("eload-custom-amount").value = "";
    $("eload-custom-row")?.classList.add("hidden");
    renderAmountGrid();
    updateSellPreview();
  } catch (err) {
    playErrorSound(); showToast(`Failed: ${err.code || err.message} ❌`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* =========================================================
   CONFIRMATION
   ========================================================= */
function showSaleConfirmation(data) {
  const preview = $("eload-preview");
  if (!preview) return;

  preview.innerHTML = `
    <div class="eload-confirm">
      <div class="eload-confirm-head">
        <span class="eload-confirm-icon">✅</span>
        <span>Load sent successfully</span>
      </div>
      <div class="eload-confirm-row"><span>Network</span><strong style="color:${data.network.color}">${esc(data.network.name)}</strong></div>
      <div class="eload-confirm-row"><span>Number</span><strong class="mono">${esc(prettyPhone(data.phone))}</strong></div>
      <div class="eload-confirm-row"><span>Amount</span><strong>${fmtMoney(data.amount)}</strong></div>
      <div class="eload-confirm-row"><span>Service Fee</span><strong class="eload-ok">${data.feePct}%</strong></div>
      <div class="eload-confirm-row"><span>Profit</span><strong class="eload-ok">+${fmtMoney(data.profit)}</strong></div>
      <div class="eload-confirm-row"><span>Receipt</span><strong class="mono">${esc(data.receiptNum)}</strong></div>
      <button type="button" class="btn ghost sm eload-confirm-print" id="eload-print-slip">🖨️ Print slip</button>
    </div>
  `;
  $("eload-print-slip")?.addEventListener("click", () => printEloadSlipFromData(data));
}

function printEloadSlipFromData(d) {
  printHTML(`
    <h1>E-Load Slip</h1>
    <div class="meta">${esc(getStoreDisplayName())} · ${new Date().toLocaleString()}</div>
    <table>
      <tr><th style="width:180px">Receipt #</th><td>${esc(d.receiptNum)}</td></tr>
      <tr><th>Network</th><td>${esc(d.network.name)}</td></tr>
      <tr><th>Number</th><td>${esc(d.phone)}</td></tr>
      <tr><th>Amount</th><td><strong>${fmtMoney(d.amount)}</strong></td></tr>
      ${d.customerName ? `<tr><th>Customer</th><td>${esc(d.customerName)}</td></tr>` : ""}
      <tr><th>Service Fee</th><td>${fmtMoney(d.amount - d.cost)}</td></tr>
      <tr><th>Profit</th><td>${fmtMoney(d.profit)}</td></tr>
    </table>
    <p style="margin-top:18px;text-align:center;font-size:12px;color:#666;">
      Load has been sent. Please keep this slip for reference.
    </p>
  `, "E-Load");
}

/* =========================================================
   LIST
   ========================================================= */
function getFilteredTransactions() {
  const term = valOf($("eload-search")).toLowerCase().trim();
  const netFilter = valOf($("eload-filter-network"));
  const range = valOf($("eload-filter-range"));
  let list = state.eloadTransactions.slice();

  if (netFilter) list = list.filter(t => t.network === netFilter);

  if (range) {
    const now = Date.now();
    const dayMs = 86400000;
    let cutoff = 0;
    if (range === "today") { const t = new Date(); t.setHours(0,0,0,0); cutoff = t.getTime(); }
    else if (range === "7") cutoff = now - 7 * dayMs;
    else if (range === "30") cutoff = now - 30 * dayMs;
    list = list.filter(t => (t.createdAt?.toMillis?.() ?? 0) >= cutoff);
  }

  if (term) {
    list = list.filter(t =>
      (t.phone || "").toLowerCase().includes(term) ||
      (t.customerName || "").toLowerCase().includes(term) ||
      (t.receiptNum || "").toLowerCase().includes(term) ||
      (t.network || "").toLowerCase().includes(term)
    );
  }
  return list;
}

function renderEloadList() {
  const list = $("eload-list"); if (!list) return;

  const filterSel = $("eload-filter-network");
  if (filterSel) {
    const nets = new Set();
    state.eloadTransactions.forEach(t => { if (t.network) nets.add(t.network); });
    const sorted = [...nets].sort();
    const cur = filterSel.value;
    const sig = sorted.join("|");
    if (filterSel.dataset.sig !== sig) {
      filterSel.dataset.sig = sig;
      filterSel.innerHTML = `<option value="">All Networks</option>` +
        sorted.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
      if (cur && sorted.includes(cur)) filterSel.value = cur;
    }
  }

  const filtered = getFilteredTransactions();
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><p>📱 No E-Load transactions yet — sell your first load above.</p></div>`;
    return;
  }

  list.innerHTML = filtered.slice(0, 100).map(t => {
    const date = t.createdAt?.toDate?.().toLocaleString() || "—";
    const net = loadNetworks().find(n => n.id === t.networkId || n.name === t.network);
    const color = net?.color || "var(--brand)";
    const initial = (t.network || "?").charAt(0).toUpperCase();
    return `
      <div class="eload-row">
        <div class="eload-row-icon" style="background:${color}">${esc(initial)}</div>
        <div class="eload-row-main">
          <div class="eload-row-title">
            <strong>${esc(t.network || "Load")}</strong>
            <span class="eload-row-phone">${esc(prettyPhone(t.phone || ""))}</span>
            ${t.customerName ? `<span class="eload-row-cust">· ${esc(t.customerName)}</span>` : ""}
          </div>
          <div class="eload-row-meta">
            ${esc(date)}${t.receiptNum ? ` · ${esc(t.receiptNum)}` : ""}
          </div>
        </div>
        <div class="eload-row-amounts">
          <div class="eload-row-amt">${fmtMoney(t.amount)}</div>
          <div class="eload-row-profit">+${fmtMoney(t.profit)}</div>
        </div>
        <div class="eload-row-actions">
          <button type="button" class="sale-action-btn receipt" onclick="printEload('${t.id}')" title="Print slip">🖨️</button>
          <button type="button" class="sale-action-btn delete" onclick="deleteEload('${t.id}')" title="Delete">🗑️</button>
        </div>
      </div>
    `;
  }).join("");
}

export function renderEloadPage() {
  renderNetworkGrid();
  renderAmountGrid();
  renderNetworkSettings();
  renderWalletUI();
  renderEloadSummary();
  renderEloadList();
  updateSellPreview();
}

/* =========================================================
   PRINT / DELETE
   ========================================================= */
export function printEload(id) {
  const t = state.eloadTransactions.find(x => x.id === id);
  if (!t) { showToast("Transaction not found ❌"); return; }
  printHTML(`
    <h1>E-Load Slip</h1>
    <div class="meta">${esc(getStoreDisplayName())} · ${new Date().toLocaleString()}</div>
    <table>
      <tr><th style="width:180px">Receipt #</th><td>${esc(t.receiptNum || "—")}</td></tr>
      <tr><th>Network</th><td>${esc(t.network || "—")}</td></tr>
      <tr><th>Number</th><td>${esc(t.phone || "—")}</td></tr>
      <tr><th>Amount</th><td><strong>${fmtMoney(t.amount)}</strong></td></tr>
      ${t.customerName ? `<tr><th>Customer</th><td>${esc(t.customerName)}</td></tr>` : ""}
      <tr><th>Service Fee</th><td>${fmtMoney(Number(t.amount) - Number(t.cost))}</td></tr>
      <tr><th>Cost</th><td>${fmtMoney(t.cost)}</td></tr>
      <tr><th>Profit</th><td>${fmtMoney(t.profit)}</td></tr>
      <tr><th>Date</th><td>${esc(t.createdAt?.toDate?.().toLocaleString() || "—")}</td></tr>
    </table>
  `, "E-Load");
}
window.printEload = printEload;

export async function deleteEload(id) {
  const t = state.eloadTransactions.find(x => x.id === id);
  if (!t) return;
  const msg = `Delete this transaction?\n\n${t.network} · ₱${t.amount} · ${t.phone}\n\n⚠️ Wallet balance will NOT be refunded.`;
  if (!confirm(msg)) return;
  try {
    await deleteDoc(doc(db, "eload_transactions", id));
    playSuccessSound(); showToast("Transaction deleted 🗑️");
  } catch (err) { showToast(`Failed: ${err.code || err.message} ❌`); }
}
window.deleteEload = deleteEload;

/* =========================================================
   EXPORTS
   ========================================================= */
export function exportEloadExcel() {
  const list = getFilteredTransactions();
  if (!list.length) { showToast("No E-Load data to export ❌"); return; }
  const rows = list.map(t => ({
    Date: t.createdAt?.toDate?.().toLocaleString() ?? "",
    Receipt: t.receiptNum || "",
    Network: t.network || "",
    Phone: t.phone || "",
    Customer: t.customerName || "",
    "Amount (₱)": Number((Number(t.amount) || 0).toFixed(2)),
    "Cost (₱)":   Number((Number(t.cost) || 0).toFixed(2)),
    "Profit (₱)": Number((Number(t.profit) || 0).toFixed(2)),
    "Service Fee (%)": Number(t.serviceFee || 0)
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "ELoad");
  downloadXLSX(wb, `eload_${new Date().toISOString().slice(0,10)}.xlsx`);
  showToast("E-Load exported ✅");
}

export function exportEloadPDF() {
  const list = getFilteredTransactions();
  if (!list.length) { showToast("No E-Load data to export ❌"); return; }
  if (!window.jspdf) { showToast("PDF library not loaded ❌"); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(16); doc.text("E-Load Transactions", 14, 18);
  doc.setFontSize(10); doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 24);
  doc.autoTable({
    startY: 30,
    head: [["Date", "Network", "Phone", "Amount", "Cost", "Profit"]],
    body: list.map(t => [
      t.createdAt?.toDate?.().toLocaleString() ?? "-",
      t.network || "-",
      t.phone || "-",
      fmtMoney(t.amount, false),
      fmtMoney(t.cost || 0, false),
      fmtMoney(t.profit || 0, false)
    ]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [18, 84, 79] }
  });
  downloadPDF(doc, `eload_${new Date().toISOString().slice(0,10)}.pdf`);
  showToast("E-Load PDF exported ✅");
}

/* =========================================================
   WALLET PROMPTS
   ========================================================= */
function promptWalletTopUp() {
  const cur = loadWallet();
  const val = prompt(`Top up your load wallet.\n\nCurrent balance: ${fmtMoney(cur.balance)}\n\nAmount to add (₱):`, "500");
  if (val === null) return;
  const n = Number(val);
  if (isNaN(n) || n <= 0) { showToast("Invalid amount ❌"); return; }
  addToWallet(n);
  renderWalletUI();
  renderEloadSummary();
  playSuccessSound();
  showToast(`Wallet topped up +${fmtMoney(n)} ✅`);
}

function promptWalletSet() {
  const cur = loadWallet();
  const val = prompt(`Set your load wallet to an exact amount.\n\nCurrent: ${fmtMoney(cur.balance)}\n\nNew balance (₱):`, String(cur.balance.toFixed(2)));
  if (val === null) return;
  const n = Number(val);
  if (isNaN(n) || n < 0) { showToast("Invalid amount ❌"); return; }
  saveWallet({ balance: n, lastTopUp: Date.now(), lastTopUpAmount: n });
  renderWalletUI(); renderEloadSummary();
  showToast(`Wallet set to ${fmtMoney(n)} ✅`);
}

function promptWalletReset() {
  if (!confirm("Reset the load wallet to ₱0.00?\n\nThis does NOT delete past transactions.")) return;
  resetWallet();
  renderWalletUI(); renderEloadSummary();
  showToast("Wallet reset ✅");
}

/* =========================================================
   INIT + LISTENERS
   ========================================================= */
export function initEload() {
  if (!_sel.networkId) _sel.networkId = DEFAULT_NETWORKS[0].id;

  renderNetworkGrid();
  renderAmountGrid();
  renderNetworkSettings();
  renderWalletUI();
  wireNetworkSettingsSave();

  $("eload-custom-toggle")?.addEventListener("click", () => {
    _sel.customMode = !_sel.customMode;
    const row = $("eload-custom-row");
    if (_sel.customMode) {
      row?.classList.remove("hidden");
      setTimeout(() => $("eload-custom-amount")?.focus(), 100);
      _sel.amount = 0;
      renderAmountGrid();
      updateSellPreview();
    } else {
      row?.classList.add("hidden");
      if ($("eload-custom-amount")) $("eload-custom-amount").value = "";
      updateSellPreview();
    }
  });

  $("eload-custom-amount")?.addEventListener("input", (e) => {
    const n = Number(e.target.value);
    _sel.amount = isNaN(n) || n < 0 ? 0 : n;
    renderAmountGrid();
    updateSellPreview();
  });

  $("eload-phone")?.addEventListener("input", (e) => {
    const formatted = normalizePhone(e.target.value);
    if (e.target.value !== formatted) e.target.value = formatted;
    updateSellPreview();
  });

  $("eload-sell-btn")?.addEventListener("click", handleSellLoad);

  $("eload-wallet-topup")?.addEventListener("click", promptWalletTopUp);
  $("eload-wallet-topup-2")?.addEventListener("click", promptWalletTopUp);
  $("eload-wallet-set")?.addEventListener("click", promptWalletSet);
  $("eload-wallet-reset")?.addEventListener("click", promptWalletReset);

  $("eload-search")?.addEventListener("input", debounce(renderEloadList, 150));
  $("eload-filter-network")?.addEventListener("change", renderEloadList);
  $("eload-filter-range")?.addEventListener("change", renderEloadList);

  $("eload-export-excel")?.addEventListener("click", exportEloadExcel);
  $("eload-export-pdf")?.addEventListener("click", exportEloadPDF);
}

export function startEloadListeners(onAfter) {
  const wsId = myWorkspace();
  if (!wsId) return;
  state.unsubscribers.eload = onSnapshot(
    query(collection(db, "eload_transactions"), where("workspaceId", "==", wsId)),
    (snap) => {
      state.eloadTransactions = snap.docs
        .map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
        .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
      safeRender(renderEloadPage);
      onAfter?.();
    },
    (err) => console.error("[ELoad listener]", err.code, err.message)
  );
}