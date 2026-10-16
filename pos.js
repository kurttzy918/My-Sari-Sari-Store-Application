/* pos.js — Point of Sale: cart, checkout, receipt */
import {
  collection, onSnapshot, doc, writeBatch, serverTimestamp, Timestamp,
  query, where, increment
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { state, CONSTANTS } from "./state.js";
import {
  $, valOf, esc, debounce, safeRender, showToast,
  myWorkspace, movementDoc, customerTxDoc, settleWrite, fmtMoney, fmtInt,
  fallbackColorFor, productImageHTML, playSuccessSound, playErrorSound, playCashSound,
  expiryStatus, getSoldMap, getFastSellingInfo,
  roundMoney, findItemByCode, getStoreDisplayName, promptStoreRename
} from "./utils.js";
import { renderCustomerPickerOptions } from "./customers.js";

const { NEW_ARRIVAL_WINDOW_MS } = CONSTANTS;

/* ✅ Bulk-selection state for recent sales */
const selectedSaleReceipts = new Set();
let salesPage = 1;
const SALES_PAGE_SIZE = 6;

/* ✅ Pagination state for POS products grid */
let posProductsPage = 1;
const POS_PRODUCTS_PAGE_SIZE_DESKTOP = 20;
const POS_PRODUCTS_PAGE_SIZE_MOBILE  = 6;

function getPosProductsPageSize() {
  return window.matchMedia("(max-width: 640px)").matches
    ? POS_PRODUCTS_PAGE_SIZE_MOBILE
    : POS_PRODUCTS_PAGE_SIZE_DESKTOP;
}

/* =========================================================
   DISCOUNT HELPER — single source of truth
   ========================================================= */
function getDiscountedPrice(item) {
  const price = Number(item.price) || 0;
  const d = Number(item.discount) || 0;
  if (d <= 0 || price <= 0) {
    return { original: price, final: price, discount: 0, percent: 0 };
  }
  if (item.discountType === "amount") {
    const final = Math.max(0, price - d);
    const percent = (d / price) * 100;
    return { original: price, final, discount: d, percent };
  }
  const cappedPct = Math.min(100, d);
  const final = Math.max(0, price - (price * cappedPct / 100));
  return { original: price, final, discount: price - final, percent: cappedPct };
}
export { getDiscountedPrice };

/* =========================================================
   SHARED BARCODE HANDLER
   ========================================================= */
export function handleBarcodeScan(code, opts = {}) {
  const { silent = false } = opts;
  const trimmed = String(code || "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  if (!state.inventory.length) {
    if (!silent) { playErrorSound(); showToast("⚠️ Inventory still loading"); }
    return { ok: false, reason: "loading" };
  }

  const item = findItemByCode(trimmed);
  if (!item) {
    if (!silent) { playErrorSound(); showToast(`Product not found: ${trimmed}`); }
    return { ok: false, reason: "not_found", code: trimmed };
  }

  if (item.quantity <= 0) {
    if (!silent) { playErrorSound(); showToast(`Out of stock: ${item.name}`); }
    return { ok: false, reason: "out_of_stock", item };
  }

  const inCart = state.posCart.find(c => c.itemId === item.id);
  const currentQty = inCart ? inCart.qty : 0;
  if (currentQty >= item.quantity) {
    if (!silent) { playErrorSound(); showToast(`Insufficient stock for ${item.name}`); }
    return { ok: false, reason: "insufficient_stock", item };
  }

  addToCart(item.id);
  if (!silent) {
    playSuccessSound();
    showToast(`✓ ${item.name} added`);
  }
  return { ok: true, item };
}

/* =========================================================
   EXTERNAL SCANNER — works WITH or WITHOUT Enter key
   ---------------------------------------------------------
   Strategy:
   1. Listen to `input` events. Debounce 250ms.
   2. If buffer >= MIN_LENGTH when timer fires → submit.
   3. Also handle Enter/Tab for scanners that DO send suffix.
   4. Guarantee focus so keystrokes land in the field.
   ========================================================= */
const EXT_SCAN_MIN_LENGTH = 4;      // ignore anything shorter
const EXT_SCAN_DEBOUNCE_MS = 250;   // wait 250ms after last char
const EXT_SCAN_LOCK_MS = 400;       // block double-fire

let _extScanTimer = null;
let _extScanLock = false;

function focusExternalScanner() {
  const inp = document.getElementById("external-barcode-input");
  if (!inp) return;

  // Don't steal focus when a modal is open
  if (document.querySelector(
    ".modal:not(.hidden), .scanner-modal:not(.hidden), .install-modal:not(.hidden)"
  )) return;

  // Don't steal focus while user is typing in another field
  const active = document.activeElement;
  if (active && active !== inp && active !== document.body) {
    const tag = active.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (active.isContentEditable) return;
  }

  try { inp.focus({ preventScroll: true }); } catch { inp.focus(); }
}

function submitExternalScan(code) {
  const trimmed = String(code || "").trim();
  if (!trimmed || trimmed.length < EXT_SCAN_MIN_LENGTH) return;
  if (_extScanLock) return;

  _extScanLock = true;
  setTimeout(() => { _extScanLock = false; }, EXT_SCAN_LOCK_MS);

  console.log("[ext-scanner] submitting:", trimmed);

  // Clear the field BEFORE processing (so next scan starts fresh)
  const inp = document.getElementById("external-barcode-input");
  if (inp) inp.value = "";

  // Process
  const result = handleBarcodeScan(trimmed);
  if (result?.ok) playSuccessSound();

  // Refocus for the next scan
  requestAnimationFrame(() => {
    try { inp?.focus({ preventScroll: true }); } catch { try { inp?.focus(); } catch {} }
  });
}

function wireExternalScanner() {
  const inp = document.getElementById("external-barcode-input");
  if (!inp) {
    console.warn("[ext-scanner] input not found");
    return;
  }

  const dot = document.getElementById("ext-scan-dot");

  const syncDot = () => {
    if (!dot) return;
    dot.classList.toggle("ready", document.activeElement === inp);
  };
  inp.addEventListener("focus", syncDot);
  inp.addEventListener("blur", syncDot);
  syncDot();

  /* ============================================================
     PRIMARY HANDLER — auto-submit after debounce
     Works regardless of whether scanner sends Enter/Tab or not
     ============================================================ */
  inp.addEventListener("input", () => {
    clearTimeout(_extScanTimer);
    const val = inp.value.trim();

    // If the scanner already delivered a full code AND we're sure
    // the user isn't still typing, submit after the debounce window
    if (val.length < EXT_SCAN_MIN_LENGTH) return;

    _extScanTimer = setTimeout(() => {
      const code = inp.value.trim();
      if (code && code.length >= EXT_SCAN_MIN_LENGTH) {
        submitExternalScan(code);
      }
    }, EXT_SCAN_DEBOUNCE_MS);
  });

  /* ============================================================
     SUFFIX HANDLER — instant submit if scanner sends Enter/Tab
     ============================================================ */
  inp.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== "Tab") return;
    e.preventDefault();
    e.stopPropagation();

    clearTimeout(_extScanTimer);
    const code = inp.value.trim();
    if (code) submitExternalScan(code);
  });

  /* ============================================================
     FOCUS MANAGEMENT — keep the field hot
     ============================================================ */

  // 1) When user navigates to POS, focus the field
  document.querySelectorAll('.nav-btn[data-page="page-sales"]').forEach(btn => {
    btn.addEventListener("click", () => setTimeout(focusExternalScanner, 150));
  });

  // 2) When user clicks empty area on POS page, focus the field
  const page = document.getElementById("page-sales");
  page?.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("input, textarea, select, button, a, .pos-card, [role='button']")) return;
    focusExternalScanner();
  });

  // 3) When window regains focus while POS visible, refocus
  window.addEventListener("focus", () => {
    const posVisible = !document.getElementById("page-sales")?.classList.contains("hidden");
    if (posVisible) setTimeout(focusExternalScanner, 100);
  });

  // 4) Initial focus when POS module loads
  setTimeout(focusExternalScanner, 300);
}

/* =========================================================
   CART PRICE RESOLUTION
   ========================================================= */
function getCartUnitPrice(ci) {
  const item = state.inventory.find(i => i.id === ci.itemId);
  if (!item) return roundMoney(ci.price);
  return roundMoney(getDiscountedPrice(item).final);
}

function syncCartPrices() {
  state.posCart.forEach(ci => {
    const item = state.inventory.find(i => i.id === ci.itemId);
    if (!item) return;
    const disc = getDiscountedPrice(item);
    ci.price           = roundMoney(disc.final);
    ci.originalPrice   = roundMoney(disc.original);
    ci.discount        = roundMoney(disc.discount);
    ci.discountPercent = Number(disc.percent) || 0;
  });
}

/* =========================================================
   CART
   ========================================================= */
export function addToCart(itemId) {
  const item = state.inventory.find(i => i.id === itemId);
  if (!item) return;
  if (item.quantity <= 0) { playErrorSound(); showToast("Out of stock ❌"); return; }

  const disc = getDiscountedPrice(item);

  const existing = state.posCart.find(c => c.itemId === itemId);
  if (existing) {
    if (existing.qty + 1 > item.quantity) { playErrorSound(); showToast("Not enough stock ❌"); return; }
    existing.qty++;
    existing.stock = item.quantity;
  } else {
    state.posCart.push({
      itemId,
      name: item.name,
      price:           roundMoney(disc.final),
      originalPrice:   roundMoney(disc.original),
      discount:        roundMoney(disc.discount),
      discountPercent: Number(disc.percent) || 0,
      qty: 1,
      stock: item.quantity
    });
  }
  syncCartPrices();
  renderPosCart();
  updateChange();
}

function updateCartQty(itemId, delta) {
  const entry = state.posCart.find(c => c.itemId === itemId);
  if (!entry) return;
  const item = state.inventory.find(i => i.id === itemId);
  if (!item) { removeFromCart(itemId); return; }
  const next = entry.qty + delta;
  if (next <= 0) { removeFromCart(itemId); return; }
  if (next > item.quantity) { playErrorSound(); showToast("Not enough stock ❌"); return; }
  entry.qty = next; entry.stock = item.quantity;
  renderPosCart(); updateChange();
}

function removeFromCart(itemId) {
  state.posCart = state.posCart.filter(c => c.itemId !== itemId);
  renderPosCart(); updateChange();
}

function getCartTotal() {
  return roundMoney(
    state.posCart.reduce((sum, c) => sum + c.qty * getCartUnitPrice(c), 0)
  );
}

function clearCart() {
  state.posCart = [];
  if ($("pos-cash")) $("pos-cash").value = "";
  renderPosCart(); updateChange();
}

export function renderPosCart() {
  const el = $("pos-cart-items"); if (!el) return;

  syncCartPrices();

  if (!state.posCart.length) {
    el.innerHTML = `<div class="pos-cart-empty">Tap a product or scan a barcode to add.</div>`;
  } else {
    el.innerHTML = state.posCart.map(c => {
      const hasDisc = c.discount && c.discount > 0;
      const metaHTML = hasDisc
        ? `<span class="pos-ci-original">${fmtMoney(c.originalPrice)}</span> ${fmtMoney(c.price)} × ${c.qty}`
        : `${fmtMoney(c.price)} × ${c.qty}`;
      return `
      <div class="pos-cart-item">
        <div class="pos-ci-main">
          <div class="pos-ci-name">${esc(c.name)}</div>
          <div class="pos-ci-meta">${metaHTML}</div>
        </div>
        <div class="pos-ci-qty">
          <button type="button" class="pos-qty-btn" data-act="dec" data-id="${c.itemId}">−</button>
          <span class="pos-ci-qty-num">${c.qty}</span>
          <button type="button" class="pos-qty-btn" data-act="inc" data-id="${c.itemId}">+</button>
        </div>
        <div class="pos-ci-sub">${fmtMoney(roundMoney(c.price * c.qty))}</div>
        <button type="button" class="pos-ci-remove" data-act="rm" data-id="${c.itemId}" title="Remove">✕</button>
      </div>
      `;
    }).join("");
  }

  if ($("pos-total")) $("pos-total").textContent = fmtMoney(getCartTotal());
}

export function updateChange() {
  const el = $("pos-change"); if (!el) return;
  const total  = getCartTotal();
  const cash   = roundMoney(valOf($("pos-cash")));
  const change = roundMoney(cash - total);

  if (cash === 0) {
    el.textContent = fmtMoney(0);
    el.classList.remove("insufficient");
  } else if (change < 0) {
    el.textContent = "−" + fmtMoney(Math.abs(change));
    el.classList.add("insufficient");
  } else {
    el.textContent = fmtMoney(change);
    el.classList.remove("insufficient");
  }
}

/* =========================================================
   PAYMENT MODE TOGGLE
   ========================================================= */
export function togglePaymentMode() {
  const mode = $("pos-payment-mode")?.value || "cash";
  const isCredit = mode === "credit";
  $("pos-cash-row")?.classList.toggle("hidden", isCredit);
  $("pos-change-row")?.classList.toggle("hidden", isCredit);
  $("pos-customer-row")?.classList.toggle("hidden", !isCredit);
  $("pos-credit-note")?.classList.toggle("hidden", !isCredit);
  if (isCredit) {
    renderCustomerPickerOptions();
    if ($("pos-cash")) $("pos-cash").value = "";
    updateChange();
  }
}
window.togglePaymentMode = togglePaymentMode;

/* =========================================================
   PRODUCT GRID
   ========================================================= */
export function buildPosMiniSlides(item, sold) {
  const slides = [];
  const isLow = item.quantity > 0 && item.quantity <= (item.threshold ?? 5);
  const isOut = item.quantity === 0;
  const createdMs = item.createdAt?.toMillis?.() ?? 0;
  const isNew = createdMs && (Date.now() - createdMs) < NEW_ARRIVAL_WINDOW_MS;
  const fast = getFastSellingInfo(item.id, sold);
  const revenue = sold * (item.price || 0);
  const exp = expiryStatus(item.expiry);
  const disc = getDiscountedPrice(item);

  if (exp.level === "expired") slides.push({ cls: "expiry", text: `⛔ ${exp.label.toUpperCase()}` });
  else if (exp.level === "expiring") slides.push({ cls: "expiry", text: `⏰ ${exp.label.toUpperCase()}` });

  if (disc.discount > 0) {
    const pct = Math.round(disc.percent);
    const tag = item.discountType === "amount"
      ? `₱${Number(disc.discount).toFixed(2)} OFF`
      : `${pct}% OFF`;
    slides.push({ cls: "discount", text: `💥 ${tag} · ${fmtMoney(disc.final)}` });
  }

  if (isNew) slides.push({ cls: "new", text: "✨ NEW ARRIVAL" });

  if (fast.isFast) slides.push({ cls: "hot", text: `🔥 FAST SELLING · ${fast.perDay.toFixed(1)}/DAY` });
  else if (sold > 0) slides.push({ cls: "hot", text: `🔥 ${fmtInt(sold)} SOLD` });

  if (isOut) slides.push({ cls: "low", text: "🚫 OUT OF STOCK" });
  else if (isLow) slides.push({ cls: "low", text: `⚠️ ONLY ${fmtInt(item.quantity)} LEFT` });

  if (revenue > 0) slides.push({ cls: "ok", text: `💰 ${fmtMoney(revenue)} SALES` });

  slides.push({ cls: "ok", text: `📦 ${fmtInt(item.quantity)} IN STOCK` });
  return slides;
}

export function renderPosProducts() {
  const grid = $("sales-products-grid"); if (!grid) return;
  const term = valOf($("sales-search")).toLowerCase().trim();
  const catFilter = valOf($("sales-cat-filter"));

  const filtered = state.inventory.filter(i => {
    if (catFilter && i.category !== catFilter) return false;
    if (!term) return true;
    return (i.name || "").toLowerCase().includes(term) ||
           (i.sku || "").toLowerCase().includes(term) ||
           (i.barcode || "").toLowerCase().includes(term);
  });

  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state"><p>📭 No products.</p></div>`;
    const pag = $("sales-products-pagination");
    if (pag) pag.innerHTML = "";
    stopPosMiniCarousels();
    return;
  }

  /* ---------- Pagination (responsive page size) ---------- */
  const pageSize = getPosProductsPageSize();
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (posProductsPage > totalPages) posProductsPage = totalPages;
  if (posProductsPage < 1) posProductsPage = 1;
  const start = (posProductsPage - 1) * pageSize;
  const pageItems = filtered.slice(start, start + pageSize);

  const soldMap = getSoldMap();

  grid.innerHTML = pageItems.map(item => {
    const isOut = item.quantity === 0;
    const isLow = item.quantity > 0 && item.quantity <= (item.threshold ?? 5);
    const sold = soldMap[item.id] || 0;
    const media = item.image
      ? `<img src="${item.image}" alt="${esc(item.name)}" loading="lazy" />`
      : `<div class="fallback" style="background:${fallbackColorFor(item.name)}">${esc((item.name || "?").charAt(0).toUpperCase())}</div>`;
    const stockPill = isOut
      ? `<span class="pos-stock-pill out">Out</span>`
      : isLow
      ? `<span class="pos-stock-pill low">${fmtInt(item.quantity)} left</span>`
      : `<span class="pos-stock-pill">${fmtInt(item.quantity)}</span>`;
    const slides = buildPosMiniSlides(item, sold);
    const slideHTML = slides.map(s => `<div class="pos-mini-slide ${s.cls}">${esc(s.text)}</div>`).join("");

    const disc = getDiscountedPrice(item);
    const hasDiscount = disc.discount > 0;
    const priceHTML = hasDiscount
      ? `<div class="pos-price pos-price-discount">
           <span class="pos-price-original">${fmtMoney(disc.original)}</span>
           <span class="pos-price-final">${fmtMoney(disc.final)}</span>
         </div>`
      : `<div class="pos-price">${fmtMoney(disc.original)}</div>`;

    const saleBadge = hasDiscount
      ? `<span class="pos-sale-badge">💥 ${item.discountType === "amount" ? "₱" + Number(disc.discount).toFixed(2) : Math.round(disc.percent) + "%"}</span>`
      : "";

    return `
      <div class="pos-card ${isOut ? "is-out" : ""}" data-id="${item.id}">
        <div class="pos-media">${media}${stockPill}${saleBadge}</div>
        <div class="pos-info">
          <div class="pos-name" title="${esc(item.name)}">${esc(item.name)}</div>
          ${priceHTML}
          <div class="pos-sku">${esc(item.barcode || item.sku)}</div>
        </div>
        <div class="pos-mini" data-count="${slides.length}">
          <div class="pos-mini-track">${slideHTML}</div>
        </div>
      </div>
    `;
  }).join("");

  grid.querySelectorAll(".pos-card").forEach(card => {
    card.addEventListener("click", () => addToCart(card.dataset.id));
  });

  startPosMiniCarousels();

  /* ---------- Pagination bar ---------- */
  renderPosProductsPagination(total, posProductsPage, totalPages);
}

/* =========================================================
   ✅ POS PRODUCTS PAGINATION
   ========================================================= */
function renderPosProductsPagination(total, currentPage, totalPages) {
  const el = $("sales-products-pagination");
  if (!el) return;

  const pageSize = getPosProductsPageSize();
  if (total <= pageSize) { el.innerHTML = ""; return; }

  const from = (currentPage - 1) * pageSize + 1;
  const to = Math.min(total, currentPage * pageSize);

  const btn = (label, page, disabled, active = false) => `
    <button type="button"
            class="page-btn ${active ? "active" : ""}"
            ${disabled ? "disabled" : ""}
            data-page="${page}">${label}</button>`;

  const pages = [];
  const maxVisible = 5;
  let startP = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  let endP = Math.min(totalPages, startP + maxVisible - 1);
  if (endP - startP + 1 < maxVisible) startP = Math.max(1, endP - maxVisible + 1);
  for (let p = startP; p <= endP; p++) pages.push(p);

  el.innerHTML = `
    <div class="page-info">Showing <strong>${from}–${to}</strong> of <strong>${total}</strong> products</div>
    <div class="page-controls">
      ${btn("‹", currentPage - 1, currentPage <= 1)}
      ${startP > 1 ? btn("1", 1, false, currentPage === 1) : ""}
      ${startP > 2 ? `<span class="page-ellipsis">…</span>` : ""}
      ${pages.map(p => btn(p, p, false, p === currentPage)).join("")}
      ${endP < totalPages - 1 ? `<span class="page-ellipsis">…</span>` : ""}
      ${endP < totalPages ? btn(totalPages, totalPages, false, currentPage === totalPages) : ""}
      ${btn("›", currentPage + 1, currentPage >= totalPages)}
    </div>
  `;

  el.querySelectorAll(".page-btn[data-page]").forEach(b => {
    if (b.disabled) return;
    b.addEventListener("click", () => {
      const p = Number(b.dataset.page);
      if (p !== currentPage && p >= 1 && p <= totalPages) {
        posProductsPage = p;
        renderPosProducts();
        document.getElementById("sales-products-grid")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });
}

export function startPosMiniCarousels() {
  stopPosMiniCarousels();
  state.posMiniIndex = 0;
  state.posMiniTimer = setInterval(() => {
    const salesHidden = $("page-sales")?.classList.contains("hidden");
    const dashHidden  = $("page-dashboard")?.classList.contains("hidden");
    if (salesHidden && dashHidden) return;
    if (!$("scanner-modal")?.classList.contains("hidden")) return;

    state.posMiniIndex++;
    document.querySelectorAll(".pos-mini").forEach(carousel => {
      const count = parseInt(carousel.dataset.count || "1");
      if (count <= 1) return;
      const idx = state.posMiniIndex % count;
      const track = carousel.querySelector(".pos-mini-track");
      if (track) track.style.transform = `translateY(-${idx * 24}px)`;
    });
  }, 2600);
}
export function stopPosMiniCarousels() {
  if (state.posMiniTimer) { clearInterval(state.posMiniTimer); state.posMiniTimer = null; }
}

/* =========================================================
   CHECKOUT
   ========================================================= */
function newReceiptNum() {
  const d = new Date();
  const ymd = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  const sod = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()).toString(36).toUpperCase().padStart(4, "0");
  const rnd = Math.floor(Math.random() * 36).toString(36).toUpperCase();
  return `INV-${ymd}-${sod}${rnd}`;
}

const CASH_SHORT_TOLERANCE = 0.005;

async function handleCheckout() {
  if (state.checkoutBusy) return;
  if (!state.posCart.length) { showToast("Cart is empty ❌"); return; }
  const wsId = myWorkspace();
  if (!wsId) { showToast("Workspace not ready ❌"); return; }

  syncCartPrices();

  const lines = [];
  for (const ci of state.posCart) {
    const item = state.inventory.find(i => i.id === ci.itemId);
    if (!item) { playErrorSound(); showToast(`"${ci.name}" no longer exists ❌`); return; }
    if (ci.qty > item.quantity) { playErrorSound(); showToast(`Not enough stock for ${item.name} ❌`); return; }

    const disc          = getDiscountedPrice(item);
    const salePrice     = roundMoney(disc.final);
    const originalPrice = roundMoney(disc.original);
    const discountAmt   = roundMoney(disc.discount);
    const discountPct   = Number(disc.percent) || 0;

    ci.price           = salePrice;
    ci.originalPrice   = originalPrice;
    ci.discount        = discountAmt;
    ci.discountPercent = discountPct;

    lines.push({
      item,
      qty: ci.qty,
      price: salePrice,
      originalPrice,
      discount: discountAmt,
      discountPercent: discountPct
    });
  }

  const total = roundMoney(
    lines.reduce((sum, line) => sum + line.qty * line.price, 0)
  );

  const mode = $("pos-payment-mode")?.value || "cash";
  const customerId = valOf($("pos-customer"));
  let cash = 0, change = 0, customer = null;

  if (mode === "cash") {
    cash = roundMoney(valOf($("pos-cash")));

    if (cash < total - CASH_SHORT_TOLERANCE) {
      playErrorSound();
      showToast(`Insufficient cash — need ${fmtMoney(total)} ❌`);
      renderPosCart();
      updateChange();
      return;
    }

    change = roundMoney(cash - total);
  } else {
    if (!customerId) { playErrorSound(); showToast("Select a customer for utang ❌"); return; }
    customer = state.customers.find(c => c.id === customerId);
    if (!customer) { playErrorSound(); showToast("Customer not found ❌"); return; }
  }

  const receiptNum = newReceiptNum();
  const now = new Date();
  const cashier = state.currentUser?.email || "-";
  const nowTs = Timestamp.fromDate(now);

  state.checkoutBusy = true;
  const btn = $("pos-checkout"); if (btn) btn.disabled = true;

  try {
    const batch = writeBatch(db);
    const saleIds = [];

    lines.forEach(({ item, qty, price, originalPrice, discount, discountPercent }) => {
      const saleRef = doc(collection(db, "sales"));
      saleIds.push(saleRef.id);

      const lineTotal  = roundMoney(qty * price);
      const unitCost   = Number(item.cost) || 0;
      const lineProfit = roundMoney((price - unitCost) * qty);
      const isCash     = mode === "cash";

      batch.set(saleRef, {
        itemId: item.id, itemName: item.name, category: item.category,
        quantity: qty,
        unitPrice: price,
        originalUnitPrice: originalPrice,
        discountAmount: discount,
        discountPercent: discountPercent,
        total: lineTotal,
        cost: unitCost,
        profit: lineProfit,
        workspaceId: wsId, receiptNum, cash, change,
        paymentMode: mode,
        customerId: customer?.id || null,
        customerName: customer?.name || null,
        paid: isCash,
        paidAt: isCash ? nowTs : null,
        amountPaid: isCash ? lineTotal : 0,
        unpaidAmount: isCash ? 0 : lineTotal,
        createdAt: nowTs,
        userId: state.currentUser?.uid || null
      });

      batch.update(doc(db, "inventory", item.id), {
        quantity: increment(-qty), updatedAt: nowTs
      });

      const mov = movementDoc({
        itemId: item.id, itemName: item.name,
        type: "out", quantity: qty, reason: "sale", note: `Receipt ${receiptNum}`
      });
      mov.createdAt = nowTs;
      batch.set(doc(collection(db, "movements")), mov);
    });

    if (mode === "credit" && customer) {
      const customerTotal = roundMoney(
        lines.reduce((sum, l) => sum + l.qty * l.price, 0)
      );
      batch.update(doc(db, "customers", customer.id), {
        balance: increment(customerTotal),
        totalPurchases: increment(customerTotal),
        lastPurchaseAt: nowTs,
        updatedAt: nowTs
      });
      const cTx = customerTxDoc({
        customerId: customer.id,
        customerName: customer.name,
        type: "purchase",
        amount: customerTotal,
        receiptNum,
        saleIds,
        note: "Credit sale"
      });
      cTx.createdAt = nowTs;
      batch.set(doc(collection(db, "customer_transactions")), cTx);
    }

    await settleWrite(batch.commit(), "Sale");

    showReceipt({
      items: lines.map(l => ({ name: l.item.name, qty: l.qty, price: l.price })),
      total, cash, change, receiptNum, date: now, cashier,
      paymentMode: mode,
      customerName: customer?.name || null
    });

    playCashSound();
    clearCart();
    if ($("pos-customer")) $("pos-customer").value = "";
    if ($("pos-payment-mode")) $("pos-payment-mode").value = "cash";
    togglePaymentMode();
    showToast(mode === "credit"
      ? `Utang recorded · ${fmtMoney(total)} for ${customer.name} ✅`
      : `Sale completed · ${fmtMoney(total)} ✅`);
  } catch (err) {
    console.error("[POS sale]", err.code, err.message);
    showToast(`Failed: ${err.code || err.message} ❌`);
  } finally {
    state.checkoutBusy = false;
    if (btn) btn.disabled = false;
  }
}

/* =========================================================
   RECEIPT MODAL
   ========================================================= */
export function showReceipt(data, groupInfo) {
  const content = $("receipt-content"); if (!content) return;
  const d = data.date;
  const dateStr = d.toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const money = (n) => fmtMoney(n);
  const isCredit = data.paymentMode === "credit";

  const itemsHTML = data.items.map(it => `
    <div class="receipt-item">
      <div class="receipt-item-row1">
        <span>${esc(it.name)}</span>
        <span>${money(roundMoney((Number(it.qty) || 0) * (Number(it.price) || 0)))}</span>
      </div>
      <div class="receipt-item-row2">
        <span>${Number(it.qty) || 0} × ${money(it.price)}</span>
        <span></span>
      </div>
    </div>
  `).join("");

  content.innerHTML = `
    <div class="receipt-header">
      <div class="receipt-store" id="receipt-store-name" title="Click to rename your store">
        ${esc(getStoreDisplayName().toUpperCase())}
      </div>
      <div class="receipt-sub">${esc(CONSTANTS.STORE_TAGLINE)}</div>
    </div>
    <div class="receipt-sep"></div>
    <div class="receipt-meta">
      <div>Date: ${esc(dateStr)}</div>
      <div>Receipt #: ${esc(data.receiptNum)}</div>
      <div>Cashier: ${esc(data.cashier || "-")}</div>
      ${isCredit ? `<div>Customer: ${esc(data.customerName || "-")}</div>` : ""}
    </div>
    <div class="receipt-sep"></div>
    <div class="receipt-items">${itemsHTML}</div>
    <div class="receipt-sep"></div>
    <div class="receipt-totals">
      <div class="rt-line big"><span>TOTAL</span><span>${money(data.total)}</span></div>
      ${isCredit
        ? `<div class="rt-line"><span>UTANG (Credit)</span><span>${money(data.total)}</span></div>`
        : `<div class="rt-line"><span>Cash</span><span>${money(data.cash)}</span></div>
           <div class="rt-line"><span>Change</span><span>${money(data.change)}</span></div>`}
    </div>
    <div class="receipt-footer">
      <strong>Thank you for your purchase!</strong>
      Please come again 🙏
    </div>
  `;

  // Wire the store-name rename (attached every time the receipt is rebuilt)
  document.getElementById("receipt-store-name")?.addEventListener("click", () => {
    promptStoreRename();
    const el = document.getElementById("receipt-store-name");
    if (el) el.textContent = getStoreDisplayName().toUpperCase();
  });

  state.currentReceiptGroup = groupInfo || null;
  const delBtn = $("delete-receipt-btn");
  if (delBtn) delBtn.classList.toggle("hidden", !state.currentReceiptGroup);
  $("receipt-modal")?.classList.remove("hidden");
}

/* =========================================================
   VIEW / DELETE SALE
   ========================================================= */
export function viewSaleReceipt(saleId) {
  const sale = state.sales.find(s => s.id === saleId);
  if (!sale) { showToast("Sale not found ❌"); return; }
  const receiptNum = sale.receiptNum;
  const lineItems = receiptNum ? state.sales.filter(s => s.receiptNum === receiptNum) : [sale];
  const items = lineItems.map(s => ({ name: s.itemName, qty: s.quantity, price: s.unitPrice || 0 }));
  const total  = roundMoney(lineItems.reduce((sum, s) => sum + (s.total || 0), 0));
  const cash   = roundMoney(sale.cash   || total);
  const change = roundMoney(sale.change || 0);
  const date   = sale.createdAt?.toDate?.() || new Date();
  showReceipt({
    items, total, cash, change,
    receiptNum: receiptNum || ("SALE-" + saleId.slice(0, 8).toUpperCase()),
    date, cashier: state.currentUser?.email || "-",
    paymentMode: sale.paymentMode || "cash",
    customerName: sale.customerName || null
  }, {
    receiptNum: receiptNum || ("SALE-" + saleId.slice(0, 8).toUpperCase()),
    saleIds: lineItems.map(s => s.id),
    total
  });
}
window.viewSaleReceipt = viewSaleReceipt;

function queueSaleRemoval(batch, sale, note) {
  if (sale.itemId && state.inventory.some(i => i.id === sale.itemId)) {
    batch.update(doc(db, "inventory", sale.itemId), {
      quantity: increment(sale.quantity || 0), updatedAt: serverTimestamp()
    });
    batch.set(doc(collection(db, "movements")), movementDoc({
      itemId: sale.itemId, itemName: sale.itemName,
      type: "in", quantity: sale.quantity || 0, reason: "adjustment", note
    }));
  }
  batch.delete(doc(db, "sales", sale.id));
}

export async function deleteSale(id) {
  const sale = state.sales.find(s => s.id === id);
  if (!sale) { showToast("Sale not found ❌"); return; }
  const msg = `Delete this sale?\n\n${sale.itemName} × ${sale.quantity} — ${fmtMoney(sale.total)}\n\n⚠️ Quantity will be restored to inventory.`;
  if (!confirm(msg)) return;
  try {
    const batch = writeBatch(db);
    queueSaleRemoval(batch, sale, `Sale ${sale.receiptNum || id} deleted`);
    await settleWrite(batch.commit(), "Delete sale");
    playSuccessSound(); showToast("Sale deleted & stock restored ✅");
  } catch (err) { showToast(`Failed: ${err.code || err.message} ❌`); }
}
window.deleteSale = deleteSale;

export async function deleteReceiptGroup(saleIds, receiptNum) {
  if (!saleIds?.length) return;
  const count = saleIds.length;
  const msg = `Delete this entire receipt?\n\n${count} item${count !== 1 ? "s" : ""} will be removed.\n\n⚠️ All quantities will be restored to inventory.`;
  if (!confirm(msg)) return;
  try {
    const batch = writeBatch(db);
    saleIds.forEach(id => {
      const sale = state.sales.find(s => s.id === id);
      if (sale) queueSaleRemoval(batch, sale, `Receipt ${receiptNum || id} deleted`);
    });
    await settleWrite(batch.commit(), "Delete receipt");
    playSuccessSound();
    showToast(`Receipt deleted · ${count} item${count !== 1 ? "s" : ""} restored ✅`);
  } catch (err) { showToast(`Failed: ${err.code || err.message} ❌`); }
}

export async function deleteSaleIds(saleIds, opts = {}) {
  if (!saleIds?.length) return;
  const { skipConfirm = false, label = "" } = opts;
  if (!skipConfirm) {
    if (!confirm(`Delete ${saleIds.length} sale(s)?`)) return;
  }
  try {
    const batch = writeBatch(db);
    saleIds.forEach(id => {
      const sale = state.sales.find(s => s.id === id);
      if (sale) queueSaleRemoval(batch, sale, label || `Bulk delete`);
    });
    await settleWrite(batch.commit(), "Bulk delete");
    playSuccessSound();
    showToast(`Deleted ${saleIds.length} item${saleIds.length !== 1 ? "s" : ""} ✅`);
  } catch (err) {
    showToast(`Failed: ${err.code || err.message} ❌`);
  }
}

/* =========================================================
   RENDER — Recent sales (grouped, paginated, bulk-select)
   ========================================================= */
export function renderSales() {
  const list = $("sales-list");
  if (!list) return;

  /* ---------- Category filter (dynamic) ---------- */
  const catSel = $("recent-sales-cat");
  if (catSel) {
    const cats = new Set();
    state.sales.forEach(s => { if (s.category) cats.add(s.category); });
    const sorted = [...cats].sort();
    const cur = catSel.value;
    const sig = sorted.join("|");
    if (catSel.dataset.sig !== sig) {
      catSel.dataset.sig = sig;
      catSel.innerHTML = `<option value="">All Categories</option>` +
        sorted.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
      if (cur && sorted.includes(cur)) catSel.value = cur;
    }
  }

  if (!state.sales.length) {
    list.innerHTML = `<div class="empty-state"><p>🛒 No sales recorded yet.</p></div>`;
    const pag = $("sales-pagination");
    if (pag) pag.innerHTML = "";
    updateSalesBulkUI();
    return;
  }

  const term = valOf($("recent-sales-search")).toLowerCase().trim();
  const catFilter = valOf($("recent-sales-cat")).trim().toLowerCase();

  /* ---------- Group sales by receipt ---------- */
  const groups = new Map();
  state.sales.forEach(s => {
    const key = s.receiptNum || ("LEGACY-" + s.id);
    if (!groups.has(key)) {
      groups.set(key, {
        receiptNum: s.receiptNum || "—",
        date: s.createdAt?.toDate?.() || new Date(),
        paymentMode: s.paymentMode || "cash",
        customerName: s.customerName || null,
        items: [],
        total: 0
      });
    }
    const g = groups.get(key);
    g.items.push(s);
    g.total += Number(s.total) || 0;
  });

  let recent = [...groups.values()];

  /* ---------- Filtering ---------- */
  if (term || catFilter) {
    recent = recent.filter(g => {
      const catOk = !catFilter || g.items.some(
        it => (it.category || "").toLowerCase() === catFilter
      );
      if (!catOk) return false;
      if (!term) return true;

      if (g.receiptNum.toLowerCase().includes(term)) return true;

      return g.items.some(it => {
        const name = (it.itemName || "").toLowerCase();
        const cat  = (it.category || "").toLowerCase();
        const note = (it.note || "").toLowerCase();
        return name.includes(term) || cat.includes(term) || note.includes(term);
      });
    });
  }

  if (!recent.length) {
    list.innerHTML = `<div class="empty-state"><p>🔍 No recent sales match your filter.</p></div>`;
    const pag = $("sales-pagination");
    if (pag) pag.innerHTML = "";
    updateSalesBulkUI();
    return;
  }

  /* ---------- Pagination ---------- */
  const total = recent.length;
  const totalPages = Math.max(1, Math.ceil(total / SALES_PAGE_SIZE));
  if (salesPage > totalPages) salesPage = totalPages;
  if (salesPage < 1) salesPage = 1;
  const start = (salesPage - 1) * SALES_PAGE_SIZE;
  const pageGroups = recent.slice(start, start + SALES_PAGE_SIZE);

  /* ---------- Render rows ---------- */
  list.innerHTML = pageGroups.map(g => {
    const qtyTotal = g.items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
    const itemCount = g.items.length;
    const timeStr = g.date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const dateStr = g.date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const isCredit = g.paymentMode === "credit";
    const isSelected = selectedSaleReceipts.has(g.receiptNum);

    const itemsHTML = g.items.map(it => {
      const disc = Number(it.discountAmount) || 0;
      const hasDisc = disc > 0;
      return `
        <div class="sale-item-line">
          <span class="sale-item-name" title="${esc(it.itemName || "Item")}">
            ${esc(it.itemName || "Item")}
            ${Number(it.quantity) > 1 ? `<span class="sale-item-qty">×${fmtInt(it.quantity)}</span>` : ""}
            ${hasDisc ? `<span class="sale-item-disc">💥</span>` : ""}
          </span>
          <span class="sale-item-cat">${esc(it.category || "")}</span>
          <span class="sale-item-price">${fmtMoney(it.total)}</span>
        </div>
      `;
    }).join("");

    const firstId = g.items[0]?.id || "";
    const idsJson = JSON.stringify(g.items.map(it => it.id)).replace(/'/g, "&#39;");

    return `
      <article class="sale-card ${isSelected ? "is-selected" : ""}" data-receipt="${esc(g.receiptNum)}">
        <header class="sale-card-head">
          <label class="history-receipt-check" title="Select receipt">
            <input type="checkbox"
                   class="sale-card-checkbox"
                   data-receipt="${esc(g.receiptNum)}"
                   ${isSelected ? "checked" : ""} />
          </label>
          <div class="sale-card-meta">
            <span class="sale-receipt-num">${esc(g.receiptNum)}</span>
            <span class="sale-time">${esc(timeStr)} · ${esc(dateStr)}</span>
          </div>
          <span class="sale-badge ${isCredit ? "credit" : "cash"}">
            ${isCredit ? "📝 Utang" : "💵 Cash"}
          </span>
        </header>

        <div class="sale-card-items">${itemsHTML}</div>

        <footer class="sale-card-foot">
          <div class="sale-card-total">
            <span class="sale-total-label">
              ${itemCount} item${itemCount !== 1 ? "s" : ""} · ${fmtInt(qtyTotal)} pc
            </span>
            <span class="sale-total-amount">${fmtMoney(g.total)}</span>
          </div>
          <div class="sale-card-actions">
            <button type="button" class="sale-btn-icon"
                    data-action="view" data-first-id="${esc(firstId)}"
                    title="View receipt" aria-label="View receipt">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                   stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2l-3 2-3-2-3 2-3-2-3 2L4 2z"/>
                <path d="M8 8h8M8 12h8M8 16h5"/>
              </svg>
            </button>
            <button type="button" class="sale-btn-icon danger"
                    data-action="delete" data-first-id="${esc(firstId)}"
                    data-receipt="${esc(g.receiptNum)}"
                    data-ids='${idsJson}'
                    title="Delete" aria-label="Delete">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                   stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              </svg>
            </button>
          </div>
        </footer>
      </article>
    `;
  }).join("");

  /* ---------- Wire row checkboxes ---------- */
  list.querySelectorAll(".sale-card-checkbox").forEach(cb => {
    cb.addEventListener("change", () => {
      const rn = cb.dataset.receipt;
      if (cb.checked) selectedSaleReceipts.add(rn);
      else            selectedSaleReceipts.delete(rn);
      cb.closest(".sale-card")?.classList.toggle("is-selected", cb.checked);
      updateSalesBulkUI();
    });
  });

  /* ---------- Wire row action buttons ---------- */
  list.querySelectorAll(".sale-btn-icon").forEach(btn => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      const firstId = btn.dataset.firstId;
      const receiptNum = btn.dataset.receipt || "";
      if (action === "view") { viewSaleReceipt(firstId); return; }
      if (action === "delete") {
        let ids = [];
        try { ids = JSON.parse(btn.dataset.ids || "[]"); } catch { ids = [firstId]; }
        if (ids.length > 1) deleteReceiptGroup(ids, receiptNum);
        else deleteSale(firstId);
      }
    });
  });

  /* ---------- Pagination bar ---------- */
  renderSalesPagination(total, salesPage, totalPages);

  /* ---------- Bulk bar ---------- */
  wireSalesBulkUI();
  updateSalesBulkUI();
}

/* =========================================================
   ✅ SALES PAGINATION
   ========================================================= */
function renderSalesPagination(total, currentPage, totalPages) {
  const el = $("sales-pagination");
  if (!el) return;
  if (total <= SALES_PAGE_SIZE) { el.innerHTML = ""; return; }

  const from = (currentPage - 1) * SALES_PAGE_SIZE + 1;
  const to = Math.min(total, currentPage * SALES_PAGE_SIZE);

  const btn = (label, page, disabled, active = false) => `
    <button type="button"
            class="page-btn ${active ? "active" : ""}"
            ${disabled ? "disabled" : ""}
            data-page="${page}">${label}</button>`;

  const pages = [];
  const maxVisible = 5;
  let startP = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  let endP = Math.min(totalPages, startP + maxVisible - 1);
  if (endP - startP + 1 < maxVisible) startP = Math.max(1, endP - maxVisible + 1);
  for (let p = startP; p <= endP; p++) pages.push(p);

  el.innerHTML = `
    <div class="page-info">Showing <strong>${from}–${to}</strong> of <strong>${total}</strong></div>
    <div class="page-controls">
      ${btn("‹", currentPage - 1, currentPage <= 1)}
      ${startP > 1 ? btn("1", 1, false, currentPage === 1) : ""}
      ${startP > 2 ? `<span class="page-ellipsis">…</span>` : ""}
      ${pages.map(p => btn(p, p, false, p === currentPage)).join("")}
      ${endP < totalPages - 1 ? `<span class="page-ellipsis">…</span>` : ""}
      ${endP < totalPages ? btn(totalPages, totalPages, false, currentPage === totalPages) : ""}
      ${btn("›", currentPage + 1, currentPage >= totalPages)}
    </div>
  `;

  el.querySelectorAll(".page-btn[data-page]").forEach(b => {
    if (b.disabled) return;
    b.addEventListener("click", () => {
      const p = Number(b.dataset.page);
      if (p !== currentPage && p >= 1 && p <= totalPages) {
        salesPage = p;
        renderSales();
        document.getElementById("sales-list")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });
}

/* =========================================================
   ✅ SALES BULK-SELECTION UI
   ========================================================= */
function updateSalesBulkUI() {
  const bar       = $("sales-bulk-bar");
  const countEl   = $("sales-selected-count");
  const delBtn    = $("sales-delete-selected");
  const selectAll = $("sales-select-all");
  const list      = $("sales-list");

  const hasRows = !!(list && list.querySelector(".sale-card"));
  if (bar) bar.classList.toggle("hidden", !hasRows);

  if (countEl) countEl.textContent = `${selectedSaleReceipts.size} selected`;
  if (delBtn)  delBtn.disabled = selectedSaleReceipts.size === 0;

  const cbs = list ? [...list.querySelectorAll(".sale-card-checkbox")] : [];
  if (selectAll) {
    const allChecked = cbs.length > 0 && cbs.every(cb => cb.checked);
    const anyChecked = cbs.some(cb => cb.checked);
    selectAll.checked = allChecked;
    selectAll.indeterminate = !allChecked && anyChecked;
  }
}

function wireSalesBulkUI() {
  const selectAll = $("sales-select-all");
  const delBtn    = $("sales-delete-selected");

  if (selectAll && !selectAll.dataset.wired) {
    selectAll.dataset.wired = "1";
    selectAll.addEventListener("change", (e) => {
      const checked = e.target.checked;
      const list = $("sales-list");
      list?.querySelectorAll(".sale-card-checkbox").forEach(cb => {
        cb.checked = checked;
        const rn = cb.dataset.receipt;
        if (checked) selectedSaleReceipts.add(rn);
        else         selectedSaleReceipts.delete(rn);
        cb.closest(".sale-card")?.classList.toggle("is-selected", checked);
      });
      updateSalesBulkUI();
    });
  }

  if (delBtn && !delBtn.dataset.wired) {
    delBtn.dataset.wired = "1";
    delBtn.addEventListener("click", async () => {
      if (!selectedSaleReceipts.size) return;

      const groups = new Map();
      state.sales.forEach(s => {
        const key = s.receiptNum || ("LEGACY-" + s.id);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s.id);
      });

      const ids = [];
      selectedSaleReceipts.forEach(rn => {
        const saleIds = groups.get(rn);
        if (saleIds) ids.push(...saleIds);
      });

      if (!ids.length) { showToast("Nothing to delete"); return; }

      const n = selectedSaleReceipts.size;
      if (!confirm(
        `Delete ${n} receipt${n !== 1 ? "s" : ""}?\n\n` +
        `${ids.length} sale${ids.length !== 1 ? "s" : ""} will be removed ` +
        `and quantities restored to inventory.`
      )) return;

      delBtn.disabled = true;
      try {
        await deleteSaleIds(ids, { skipConfirm: true, label: "Bulk delete" });
        selectedSaleReceipts.clear();
        updateSalesBulkUI();
      } finally {
        delBtn.disabled = false;
      }
    });
  }
}

/* =========================================================
   INIT + LISTENERS
   ========================================================= */
export function initPOS() {
  $("pos-cart-items")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]"); if (!btn) return;
    const id = btn.dataset.id, act = btn.dataset.act;
    if (act === "inc") updateCartQty(id, 1);
    else if (act === "dec") updateCartQty(id, -1);
    else if (act === "rm") removeFromCart(id);
  });
  $("pos-cash")?.addEventListener("input", updateChange);
  $("pos-clear-btn")?.addEventListener("click", () => { clearCart(); showToast("Cart cleared 🧹"); });
  $("pos-checkout")?.addEventListener("click", handleCheckout);
  $("pos-payment-mode")?.addEventListener("change", togglePaymentMode);
    $("sales-search")?.addEventListener("input", debounce(() => {
    posProductsPage = 1;
    renderPosProducts();
  }, 150));
  $("sales-cat-filter")?.addEventListener("change", () => {
    posProductsPage = 1;
    renderPosProducts();
  });
  $("print-receipt-btn")?.addEventListener("click", () => window.print());
  $("close-receipt-btn")?.addEventListener("click", () => {
    $("receipt-modal")?.classList.add("hidden");
    state.currentReceiptGroup = null;
  });
  $("delete-receipt-btn")?.addEventListener("click", () => {
    if (!state.currentReceiptGroup) return;
    const group = state.currentReceiptGroup;
    $("receipt-modal")?.classList.add("hidden");
    state.currentReceiptGroup = null;
    deleteReceiptGroup(group.saleIds, group.receiptNum);
  });

    $("recent-sales-search")?.addEventListener("input", debounce(() => {
    salesPage = 1;
    renderSales();
  }, 150));
  $("recent-sales-cat")?.addEventListener("change", () => {
    salesPage = 1;
    renderSales();
  });

  wireExternalScanner();
}
  /* ✅ Re-render POS grid when screen size crosses the mobile breakpoint */
  let _posResizeTimer = null;
  let _lastWasMobile = window.matchMedia("(max-width: 640px)").matches;
  window.addEventListener("resize", () => {
    clearTimeout(_posResizeTimer);
    _posResizeTimer = setTimeout(() => {
      const isMobile = window.matchMedia("(max-width: 640px)").matches;
      if (isMobile !== _lastWasMobile) {
        _lastWasMobile = isMobile;
        posProductsPage = 1; // reset to page 1 when switching breakpoints
        const salesHidden = $("page-sales")?.classList.contains("hidden");
        if (!salesHidden) renderPosProducts();
      }
    }, 200);
  });

export function startSalesListener(onAfterSalesChange) {
  const wsId = myWorkspace(); if (!wsId) return;
  state.unsubscribers.sales = onSnapshot(
    query(collection(db, "sales"), where("workspaceId", "==", wsId)),
    (snap) => {
      const all = snap.docs
        .map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
        .sort((a, b) => {
          const ta = a.createdAt?.toMillis?.() ?? 0;
          const tb = b.createdAt?.toMillis?.() ?? 0;
          return tb - ta;
        });

      state.sales = all
        .filter(s => s.paymentMode !== "credit" || s.paid === true)
        .slice(0, 500);

      state.creditSales = all
        .filter(s => s.paymentMode === "credit" && s.paid !== true);

      safeRender(renderSales);
      onAfterSalesChange?.();
    },
    (err) => console.error("[Sales listener]", err.code, err.message)
  );
}