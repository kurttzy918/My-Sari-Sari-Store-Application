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
  roundMoney, findItemByCode,getStoreDisplayName, promptStoreRename
} from "./utils.js";
import { renderCustomerPickerOptions } from "./customers.js";

const { NEW_ARRIVAL_WINDOW_MS } = CONSTANTS;

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
   EXTERNAL SCANNER — keyboard-wedge integration
   (Single source: the dedicated #external-barcode-input)
   ========================================================= */
let _extScanLock = false;

function focusExternalScanner() {
  const inp = document.getElementById("external-barcode-input");
  if (!inp) return;

  // Don't steal focus while a modal / camera scanner is open
  if (document.querySelector(
    ".modal:not(.hidden), .scanner-modal:not(.hidden), .install-modal:not(.hidden)"
  )) return;

  // Don't steal focus while the cashier is typing in another field
  const active = document.activeElement;
  if (active && active !== inp && active !== document.body) {
    const tag = active.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (active.isContentEditable) return;
  }

  try { inp.focus({ preventScroll: true }); } catch { inp.focus(); }
}

function wireExternalScanner() {
  const inp = document.getElementById("external-barcode-input");
  if (!inp) return;

  const dot = document.getElementById("ext-scan-dot");

  const syncDot = () => {
    if (!dot) return;
    dot.classList.toggle("ready", document.activeElement === inp);
  };
  inp.addEventListener("focus", syncDot);
  inp.addEventListener("blur", syncDot);
  syncDot();

  // Handles both Enter AND Tab (many USB scanners use Tab as suffix).
  inp.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== "Tab") return;
    e.preventDefault();

    const code = String(inp.value || "").trim();
    inp.value = "";

    // Guard against scanners that fire the suffix twice
    if (!code || _extScanLock) return;
    _extScanLock = true;
    setTimeout(() => { _extScanLock = false; }, 160);

    handleBarcodeScan(code);

    // Keep the field ready for the next scan
    requestAnimationFrame(() => {
      try { inp.focus({ preventScroll: true }); } catch { inp.focus(); }
      syncDot();
    });
  });

  // Some scanners fire NumpadEnter which triggers keypress as well
  inp.addEventListener("keypress", (e) => {
    if (e.key === "Enter") e.preventDefault();
  });

  // Auto-focus when the cashier clicks an empty area of the POS page
  const page = document.getElementById("page-sales");
  page?.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("input, textarea, select, button, a, .pos-card, [role='button']")) return;
    focusExternalScanner();
  });

  // Auto-focus when navigating to POS via sidebar / bottom nav
  document.querySelectorAll('.nav-btn[data-page="page-sales"]').forEach(btn => {
    btn.addEventListener("click", () => {
      setTimeout(focusExternalScanner, 120);
    });
  });
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
    stopPosMiniCarousels();
    return;
  }
  const soldMap = getSoldMap();
  grid.innerHTML = filtered.map(item => {
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
  state.currentReceiptGroup = groupInfo || null;
  const delBtn = $("delete-receipt-btn");
  if (delBtn) delBtn.classList.toggle("hidden", !state.currentReceiptGroup);
  $("receipt-modal")?.classList.remove("hidden");
}
  // Clicking the store name lets the user rename it
  document.getElementById("receipt-store-name")?.addEventListener("click", () => {
    promptStoreRename();
    // Re-render the visible name live
    const el = document.getElementById("receipt-store-name");
    if (el) el.textContent = getStoreDisplayName().toUpperCase();
  });

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
   RENDER — Recent sales list (grouped by receipt, filterable)
   ========================================================= */
export function renderSales() {
  const list = $("sales-list");
  if (!list) return;
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
    return;
  }

  const term = valOf($("recent-sales-search")).toLowerCase().trim();
  const catFilter = valOf($("recent-sales-cat")).trim().toLowerCase();

  const groups = new Map();
  state.sales.slice(0, 150).forEach(s => {
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

  /* Filter: receipt number OR any item matches (term + category) */
  let recent = [...groups.values()];
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

  recent = recent.slice(0, 12);

  if (!recent.length) {
    list.innerHTML = `<div class="empty-state"><p>🔍 No recent sales match your filter.</p></div>`;
    return;
  }

  list.innerHTML = recent.map(g => {
    const qtyTotal = g.items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
    const itemCount = g.items.length;
    const timeStr = g.date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const dateStr = g.date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const isCredit = g.paymentMode === "credit";

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
      <article class="sale-card">
        <header class="sale-card-head">
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
  $("sales-search")?.addEventListener("input", debounce(renderPosProducts, 150));
  $("sales-cat-filter")?.addEventListener("change", renderPosProducts);
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

  $("recent-sales-search")?.addEventListener("input", debounce(renderSales, 150));
  $("recent-sales-cat")?.addEventListener("change", renderSales);

  wireExternalScanner();
}

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