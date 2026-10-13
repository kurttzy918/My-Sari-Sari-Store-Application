/* inventory.js — Stock, categories, movements, scanner, photo, Excel import */
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc,
  serverTimestamp, query, where, writeBatch, increment
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { state, CONSTANTS } from "./state.js";
import {
  $, valOf, numOf, setVal, esc, debounce, safeRender, showToast,
  myWorkspace, movementDoc, settleWrite, productImageHTML,
  fallbackColorFor, expiryStatus, daysUntilExpiry, printHTML,
  playSuccessSound, playErrorSound,
  fmtInt, fmtMoney, downloadXLSX, getSoldMap
} from "./utils.js";
/* Shared helpers from pos.js so the Dashboard reuses the exact same cards */
import {
  buildPosMiniSlides, getDiscountedPrice, startPosMiniCarousels
} from "./pos.js";

const { SCANNER_STATE, SCAN_BOX, SCAN_FPS, SCAN_VIDEO, SCAN_COOLDOWN_MS, CATEGORY_IMAGE_API } = CONSTANTS;

/* =========================================================
   AUTO SKU
   ========================================================= */
export function nextSku() {
  let max = 1000;
  state.inventory.forEach(item => {
    const n = parseInt(item.sku, 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return String(max + 1);
}
export function autoFillSku() {
  const itemSku = $("item-sku"), itemId = $("item-id");
  if (!itemSku) return;
  if (itemId && itemId.value) return;
  if (state.manualSku) return;
  const next = nextSku();
  if (itemSku.value !== next) { itemSku.value = next; state.skuInitialized = true; }
}

/* =========================================================
   PHOTO HANDLING
   ========================================================= */
function compressImage(file, maxSize = 420, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let { width, height } = img;
        if (width > height) { if (width > maxSize) { height *= maxSize / width; width = maxSize; } }
        else { if (height > maxSize) { width *= maxSize / height; height = maxSize; } }
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showPhotoPreview(dataUrl) {
  const photoPreview = $("photo-preview"), photoRemoveBtn = $("photo-remove-btn");
  if (!photoPreview) return;
  if (dataUrl) {
    photoPreview.classList.add("has-image");
    photoPreview.innerHTML = `<img src="${dataUrl}" alt="Preview" />`;
    photoRemoveBtn?.classList.remove("hidden");
  } else {
    photoPreview.classList.remove("has-image");
    photoPreview.innerHTML = `<span class="photo-placeholder">📷<br>Add Photo</span>`;
    photoRemoveBtn?.classList.add("hidden");
  }
}

async function handlePhotoFile(file) {
  if (!file) return;
  try {
    const dataUrl = await compressImage(file);
    setVal($("item-image-data"), dataUrl);
    showPhotoPreview(dataUrl);
    showToast("Photo ready ✅");
  } catch (err) { console.error("[photo]", err); showToast("Failed to process photo ❌"); }
}

let _cameraStream = null;

function openCameraModal() {
  const modal = $("camera-modal");
  const video = $("camera-video");
  if (!modal || !video) return;

  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";

  navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
    .then(stream => {
      _cameraStream = stream;
      video.srcObject = stream;
    })
    .catch(err => {
      console.error("[camera]", err);
      showToast("Camera access denied or not available ❌");
      modal.classList.add("hidden");
      document.body.style.overflow = "";
    });
}

function closeCameraModal() {
  if (_cameraStream) {
    _cameraStream.getTracks().forEach(t => t.stop());
    _cameraStream = null;
  }
  const video = $("camera-video");
  if (video) video.srcObject = null;
  $("camera-modal")?.classList.add("hidden");
  document.body.style.overflow = "";
}

function captureFromCamera() {
  const video = $("camera-video");
  const canvas = $("camera-canvas");
  if (!video || !canvas) return;

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);

  canvas.toBlob(blob => {
    if (!blob) { showToast("Failed to capture photo ❌"); return; }
    const file = new File([blob], "camera-photo.jpg", { type: "image/jpeg" });
    handlePhotoFile(file);
    closeCameraModal();
  }, "image/jpeg", 0.85);
}

function wirePhotoInputs() {
  const itemImage = $("item-image"), itemImageCamera = $("item-image-camera");
  const photoCameraBtn = $("photo-camera-btn"), photoPickBtn = $("photo-pick-btn");
  const photoPreview = $("photo-preview"), photoRemoveBtn = $("photo-remove-btn");

  photoCameraBtn?.addEventListener("click", openCameraModal);
  $("camera-close")?.addEventListener("click", closeCameraModal);
  $("camera-capture")?.addEventListener("click", captureFromCamera);
  $("camera-modal")?.addEventListener("click", (e) => {
    if (e.target === $("camera-modal")) closeCameraModal();
  });

  photoPickBtn?.addEventListener("click", () => itemImage?.click());
  itemImage?.addEventListener("change", (e) => {
    handlePhotoFile(e.target.files?.[0]); e.target.value = "";
  });

  itemImageCamera?.addEventListener("change", (e) => {
    handlePhotoFile(e.target.files?.[0]); e.target.value = "";
  });

  photoPreview?.addEventListener("click", () => itemImage?.click());
  photoRemoveBtn?.addEventListener("click", () => {
    if (itemImage) itemImage.value = "";
    if (itemImageCamera) itemImageCamera.value = "";
    setVal($("item-image-data"), "");
    showPhotoPreview(null);
  });
}

/* =========================================================
   LIVE DISCOUNT PRICE PREVIEW
   ========================================================= */
function updateDiscountPreview() {
  const priceEl = $("item-price");
  const dpEl = $("item-discount-price");
  const box = $("item-discount-preview");
  if (!priceEl || !dpEl || !box) return;

  const price = Number(valOf(priceEl)) || 0;
  const dp    = Number(valOf(dpEl)) || 0;

  if (!dp || dp <= 0 || !price) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  if (dp >= price) {
    box.classList.remove("hidden");
    box.innerHTML = `<span class="dlp-warn">⚠️ Discount price must be lower than selling price (₱${price.toFixed(2)})</span>`;
    return;
  }

  const pct = ((price - dp) / price) * 100;
  const save = price - dp;
  box.classList.remove("hidden");
  box.innerHTML = `
    <span class="dlp-badge">💥 ${pct.toFixed(1)}% OFF</span>
    <span class="dlp-save">Save ${fmtMoney(save)} · Final ${fmtMoney(dp)}</span>
  `;
}

function wireDiscountPreview() {
  $("item-price")?.addEventListener("input", updateDiscountPreview);
  $("item-discount-price")?.addEventListener("input", updateDiscountPreview);
  updateDiscountPreview();
}

function computeDiscountPercent(price, discountPrice) {
  const p = Number(price) || 0;
  const dp = Number(discountPrice) || 0;
  if (!p || !dp || dp >= p) return 0;
  return ((p - dp) / p) * 100;
}

/* =========================================================
   ITEM FORM (Add / Edit)
   ========================================================= */
function wireItemForm() {
  const itemForm = $("item-form");
  if (!itemForm) return;
  itemForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const wsId = myWorkspace();
    if (!wsId) { showToast("Workspace not ready ❌"); return; }
    const itemIdEl = $("item-id");
    const wasEditing = !!(itemIdEl && itemIdEl.value);
    const prev = wasEditing ? state.inventory.find(i => i.id === itemIdEl.value) : null;

    const price = numOf($("item-price"));
    const discountPrice = Number(valOf($("item-discount-price"))) || 0;

    if (!price || price <= 0) { showToast("Price must be greater than 0 ❌"); return; }
    if (discountPrice > 0 && discountPrice >= price) {
      showToast("Discount price must be lower than selling price ❌");
      return;
    }

    const discount = computeDiscountPercent(price, discountPrice);

    const data = {
      name: valOf($("item-name")).trim(),
      sku: valOf($("item-sku")).trim(),
      barcode: valOf($("item-barcode")).trim(),
      category: valOf($("item-category")).trim(),
      quantity: numOf($("item-qty")),
      cost: Number(valOf($("item-cost"))) || 0,
      price,
      discount: Number(discount.toFixed(4)),
      discountType: "percent",
      discountPrice: discountPrice > 0 ? discountPrice : 0,
      expiry: valOf($("item-expiry")),
      threshold: Number(valOf($("item-threshold"))) || 5,
      image: valOf($("item-image-data")) || null,
      workspaceId: wsId,
      updatedAt: serverTimestamp()
    };

    if (!data.name)     { showToast("Name is required ❌"); return; }
    if (!data.sku)      { showToast("SKU is required ❌"); return; }
    if (!data.category) { showToast("Category is required ❌"); return; }

    try {
      const batch = writeBatch(db);
      if (wasEditing) {
        batch.update(doc(db, "inventory", itemIdEl.value), data);
        if (prev && data.quantity !== prev.quantity) {
          const diff = data.quantity - prev.quantity;
          batch.set(doc(collection(db, "movements")), movementDoc({
            itemId: itemIdEl.value, itemName: data.name,
            type: diff > 0 ? "in" : "out",
            quantity: Math.abs(diff), reason: "adjustment", note: "Manual edit"
          }));
        }
        await settleWrite(batch.commit(), "Item");
        showToast("Item updated ✅");
      } else {
        const newRef = doc(collection(db, "inventory"));
        batch.set(newRef, { ...data, createdAt: serverTimestamp() });
        if (data.quantity > 0) {
          batch.set(doc(collection(db, "movements")), movementDoc({
            itemId: newRef.id, itemName: data.name,
            type: "in", quantity: data.quantity, reason: "initial", note: "Item created"
          }));
        }
        await settleWrite(batch.commit(), "Item");
        showToast("Item added ✅");
      }
      itemForm.reset();
      if (itemIdEl) itemIdEl.value = "";
      if ($("item-threshold")) $("item-threshold").value = "5";
      if ($("item-discount-price")) $("item-discount-price").value = "";
      if ($("item-image-data")) $("item-image-data").value = "";
      if ($("item-image")) $("item-image").value = "";
      if ($("item-image-camera")) $("item-image-camera").value = "";
      showPhotoPreview(null);
      updateDiscountPreview();
      state.manualSku = false; state.skuInitialized = false;
      autoFillSku();
    } catch (err) {
      console.error("[add/update item] FAILED:", err);
      showToast(`Failed: ${err.code || err.message} ❌`);
    }
  });

  $("item-sku")?.addEventListener("input", () => {
    if (!state.skuInitialized) state.manualSku = true;
    else if ($("item-sku").value !== nextSku() && !state.manualSku) state.manualSku = true;
  });
}

export function editItem(id) {
  const item = state.inventory.find(i => i.id === id);
  if (!item) return;
  setVal($("item-id"), item.id);
  setVal($("item-name"), item.name);
  setVal($("item-sku"), item.sku);
  setVal($("item-barcode"), item.barcode || "");
  setVal($("item-category"), item.category);
  setVal($("item-qty"), item.quantity);
  setVal($("item-cost"), item.cost ?? "");
  setVal($("item-price"), item.price);
  setVal($("item-discount-price"), item.discountPrice ?? 0);
  setVal($("item-expiry"), item.expiry || "");
  setVal($("item-threshold"), item.threshold ?? 5);
  setVal($("item-image-data"), item.image || "");
  showPhotoPreview(item.image || null);
  updateDiscountPreview();
  state.manualSku = true; state.skuInitialized = true;
  document.querySelector('[data-page="page-add"]')?.click();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
window.editItem = editItem;

export async function deleteItem(id) {
  if (!confirm("Delete this item permanently?")) return;
  try { await deleteDoc(doc(db, "inventory", id)); showToast("Item deleted 🗑️"); }
  catch (err) { showToast(`Failed: ${err.code || err.message} ❌`); }
}
window.deleteItem = deleteItem;

/* =========================================================
   RESTOCK
   ========================================================= */
export function restockItem(id) {
  const item = state.inventory.find(i => i.id === id);
  if (!item) return;
  state.restockItemId = id;
  const nameEl = $("restock-item-name"), curEl = $("restock-current"), qtyEl = $("restock-qty");
  if (nameEl) nameEl.textContent = item.name;
  if (curEl) curEl.textContent = `Current stock: ${fmtInt(item.quantity)} · SKU: ${item.sku}${item.barcode ? " · Barcode: " + item.barcode : ""}`;
  if (qtyEl) qtyEl.value = 10;
  $("restock-modal")?.classList.remove("hidden");
  setTimeout(() => qtyEl?.focus(), 100);
}
window.restockItem = restockItem;

function wireRestock() {
  $("restock-close")?.addEventListener("click", () => $("restock-modal")?.classList.add("hidden"));
  $("restock-confirm")?.addEventListener("click", async () => {
    const qty = Number(valOf($("restock-qty")));
    if (!qty || qty <= 0) { showToast("Enter a valid quantity ❌"); return; }
    const item = state.inventory.find(i => i.id === state.restockItemId);
    if (!item) return;
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, "inventory", state.restockItemId), {
        quantity: increment(qty), updatedAt: serverTimestamp()
      });
      batch.set(doc(collection(db, "movements")), movementDoc({
        itemId: item.id, itemName: item.name,
        type: "in", quantity: qty, reason: "restock", note: ""
      }));
      await settleWrite(batch.commit(), "Restock");
      playSuccessSound();
      showToast(`Restocked +${fmtInt(qty)} ✅`);
      $("restock-modal")?.classList.add("hidden");
    } catch (err) { showToast(`Failed: ${err.code || err.message} ❌`); }
  });
}

/* =========================================================
   RENDERS — Inventory
   ========================================================= */
function stockProgress(item) {
  const t = item.threshold ?? 5;
  const capacity = Math.max(t * 3, 1);
  const percent = Math.min((item.quantity / capacity) * 100, 100);
  let level = "high";
  if (item.quantity === 0 || item.quantity <= t) level = "low";
  else if (item.quantity <= t * 2) level = "medium";
  return { percent, level };
}
export { stockProgress };

export function renderInventory() {
  const list = $("inventory-list"); if (!list) return;
  const s = valOf($("search-input")).toLowerCase().trim();
  const f = valOf($("filter-category"));

  const filtered = state.inventory.filter(i => {
    const mS = !s
      || (i.name || "").toLowerCase().includes(s)
      || (i.sku || "").toLowerCase().includes(s)
      || (i.barcode || "").toLowerCase().includes(s)
      || (i.category || "").toLowerCase().includes(s);
    const mC = !f || i.category === f;
    return mS && mC;
  });

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><p>📭 No items found.</p></div>`;
    renderPaginationBar("inventory-pagination", 0, 1, 1, () => {});
    return;
  }

  const pageSize = Math.max(5, state.invPageSize || 20);
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (state.invPage > totalPages) state.invPage = totalPages;
  if (state.invPage < 1) state.invPage = 1;
  const start = (state.invPage - 1) * pageSize;
  const pageItems = filtered.slice(start, start + pageSize);

  list.innerHTML = pageItems.map(item => {
    const isLow = item.quantity <= (item.threshold ?? 5);
    const { percent, level } = stockProgress(item);
    const exp = expiryStatus(item.expiry);
    const expBadge = exp.level === "expired" ? `<span class="badge expired">Expired</span>` :
                     exp.level === "expiring" ? `<span class="badge expiring">Expiring</span>` : "";
    const expMeta = (exp.level === "expired" || exp.level === "expiring")
      ? `<span class="expiry-tag">⏰ ${esc(exp.label)}</span>` : "";

    const hasDiscount = Number(item.discountPrice) > 0 && Number(item.discountPrice) < Number(item.price);
    const priceHTML = hasDiscount
      ? `<span class="price-original">${fmtMoney(item.price)}</span> <span class="price-discount">${fmtMoney(item.discountPrice)}</span>`
      : fmtMoney(item.price);
    const discBadge = hasDiscount
      ? `<span class="badge sale">💥 ${Math.round(item.discount || 0)}%</span>`
      : "";

    return `
      <div class="item-card ${isLow ? "low-stock" : ""} ${exp.level === "expired" ? "expiring" : ""}">
        ${productImageHTML(item)}
        <div class="item-body">
          <div class="item-header">
            <div>
              <div class="item-name">${esc(item.name)}</div>
              <div class="item-sku">SKU: ${esc(item.sku)}${item.barcode ? " · " + esc(item.barcode) : ""}</div>
            </div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;">
              ${discBadge}
              ${expBadge}
              <span class="badge ${isLow ? "low" : "ok"}">${isLow ? "Low" : "OK"}</span>
            </div>
          </div>
          <div class="item-meta">
            <span>📂 ${esc(item.category)}</span>
            <span>📦 ${fmtInt(item.quantity)}</span>
            <span>💰 ${priceHTML}</span>
            ${item.cost ? `<span>📉 Cost: ${fmtMoney(item.cost)}</span>` : ""}
            ${expMeta}
          </div>
          <div class="progress-wrap">
            <div class="progress"><div class="progress-bar ${level}" style="width:${percent}%"></div></div>
            <span class="progress-label">${percent.toFixed(0)}%</span>
          </div>
          <div class="item-actions">
            <button type="button" class="btn ghost" onclick="editItem('${item.id}')">Edit</button>
            <button type="button" class="btn ghost" onclick="openLabelFor('${item.id}')" title="Print label">🏷️</button>
            <button type="button" class="btn primary" onclick="restockItem('${item.id}')">➕ Restock</button>
            <button type="button" class="btn danger" onclick="deleteItem('${item.id}')">Delete</button>
          </div>
        </div>
      </div>`;
  }).join("");

  renderPaginationBar("inventory-pagination", total, state.invPage, pageSize, (newPage) => {
    state.invPage = newPage;
    renderInventory();
    document.querySelector('[data-page="page-add"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

/* =========================================================
   INVENTORY ANALYTICS DASHBOARD
   ========================================================= */
export function renderInventoryAnalytics() {
  if (!state.inventory || !state.inventory.length) return;

  /* ---- Totals ---- */
  let totalRetail = 0;
  let totalCost = 0;
  let totalItems = 0;
  let lowCount = 0;
  let outCount = 0;
  let expiringCount = 0;

  /* ---- Category Map ---- */
  const catMap = {};

  state.inventory.forEach(item => {
    const qty = Number(item.quantity) || 0;
    const price = Number(item.price) || 0;
    const cost = Number(item.cost) || 0;
    const threshold = item.threshold ?? 5;

    totalRetail += qty * price;
    totalCost += qty * cost;
    totalItems += qty;

    if (qty <= 0) outCount++;
    else if (qty <= threshold) lowCount++;

    const exp = expiryStatus(item.expiry);
    if (exp.level === "expiring" || exp.level === "expired") expiringCount++;

    /* Category Breakdown */
    const cat = item.category || "Uncategorized";
    if (!catMap[cat]) catMap[cat] = 0;
    catMap[cat] += qty * price;
  });

  const potentialProfit = totalRetail - totalCost;

  /* ---- Update DOM ---- */
  if ($("inv-total-retail")) $("inv-total-retail").textContent = fmtMoney(totalRetail);
  if ($("inv-total-cost")) $("inv-total-cost").textContent = fmtMoney(totalCost);
  if ($("inv-total-potential-profit")) $("inv-total-potential-profit").textContent = fmtMoney(potentialProfit);
  if ($("inv-total-items")) $("inv-total-items").textContent = fmtInt(totalItems);

  if ($("inv-count-low")) $("inv-count-low").textContent = fmtInt(lowCount);
  if ($("inv-count-out")) $("inv-count-out").textContent = fmtInt(outCount);
  if ($("inv-count-expiring")) $("inv-count-expiring").textContent = fmtInt(expiringCount);

  /* ---- Category Breakdown List ---- */
  const catListEl = $("inv-category-breakdown");
  if (catListEl) {
    const entries = Object.entries(catMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5); // Top 5

    const maxVal = entries.length ? entries[0][1] : 1;

    if (!entries.length) {
      catListEl.innerHTML = `<div class="empty-state" style="padding:10px;"><p>No categories yet.</p></div>`;
    } else {
      catListEl.innerHTML = entries.map(([cat, val]) => {
        const pct = (val / maxVal) * 100;
        return `
          <div class="inv-cat-item">
            <div class="inv-cat-row">
              <span class="inv-cat-name" title="${esc(cat)}">${esc(cat)}</span>
              <span class="inv-cat-value">${fmtMoney(val)}</span>
            </div>
            <div class="inv-cat-bar"><div class="inv-cat-bar-fill" style="width:${pct}%"></div></div>
          </div>
        `;
      }).join("");
    }
  }
}

/* Pagination bar helper (shared with history) */
function renderPaginationBar(elId, total, currentPage, pageSize, onPageChange) {
  const el = $(elId);
  if (!el) return;
  if (total === 0) { el.innerHTML = ""; return; }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
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
      if (p !== currentPage && p >= 1 && p <= totalPages) onPageChange(p);
    });
  });
}
export { renderPaginationBar };

/* =========================================================
   DASHBOARD INVENTORY — POS-style cards + mini carousel
   ========================================================= */
export function renderDashboardInventory() {
  const container = $("dashboard-inventory"); if (!container) return;

  const term = valOf($("dash-search")).toLowerCase().trim();
  const filtered = state.inventory.filter(i => {
    if (!term) return true;
    return (i.name || "").toLowerCase().includes(term) ||
           (i.sku || "").toLowerCase().includes(term) ||
           (i.barcode || "").toLowerCase().includes(term);
  });

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><p>📭 No items yet — add one to get started.</p></div>`;
    return;
  }

  const soldMap = getSoldMap();

  container.innerHTML = filtered
    .map(item => dashboardPosCardHTML(item, soldMap[item.id] || 0))
    .join("");

  // Tap → add to POS cart (same behaviour as the POS page)
  container.querySelectorAll(".pos-card").forEach(card => {
    card.addEventListener("click", () => {
      import("./pos.js").then(mod => mod.addToCart(card.dataset.id));
    });
  });

  // Kick the shared mini-carousel ticker (also runs on the POS page)
  startPosMiniCarousels();
}

/* POS-style compact card, used only by the dashboard */
function dashboardPosCardHTML(item, sold) {
  const isOut = item.quantity === 0;
  const isLow = item.quantity > 0 && item.quantity <= (item.threshold ?? 5);

  const media = item.image
    ? `<img src="${item.image}" alt="${esc(item.name)}" loading="lazy" />`
    : `<div class="fallback" style="background:${fallbackColorFor(item.name)}">${esc((item.name || "?").charAt(0).toUpperCase())}</div>`;

  const stockPill = isOut
    ? `<span class="pos-stock-pill out">Out</span>`
    : isLow
      ? `<span class="pos-stock-pill low">${fmtInt(item.quantity)} left</span>`
      : `<span class="pos-stock-pill">${fmtInt(item.quantity)}</span>`;

  const slides = buildPosMiniSlides(item, sold);
  const slideHTML = slides.map(s =>
    `<div class="pos-mini-slide ${s.cls}">${esc(s.text)}</div>`
  ).join("");

  const disc = getDiscountedPrice(item);
  const hasDiscount = disc.discount > 0;
  const priceHTML = hasDiscount
    ? `<div class="pos-price pos-price-discount">
         <span class="pos-price-original">${fmtMoney(disc.original)}</span>
         <span class="pos-price-final">${fmtMoney(disc.final)}</span>
       </div>`
    : `<div class="pos-price">${fmtMoney(disc.original)}</div>`;

  const saleBadge = hasDiscount
    ? `<span class="pos-sale-badge">💥 ${
        item.discountType === "amount"
          ? "₱" + Number(disc.discount).toFixed(2)
          : Math.round(disc.percent) + "%"
      }</span>`
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
}

export function renderLowStockAlerts() {
  const list = $("low-stock-list"); if (!list) return;
  const low = state.inventory.filter(i => i.quantity <= (i.threshold ?? 5));
  if (!low.length) { list.innerHTML = `<div class="empty-state"><p>✅ All items are well stocked.</p></div>`; return; }
  list.innerHTML = low.map(item => {
    const { percent, level } = stockProgress(item);
    return `
      <div class="item-card low-stock">
        ${productImageHTML(item)}
        <div class="item-body">
          <div class="item-header">
            <div><div class="item-name">${esc(item.name)}</div><div class="item-sku">SKU: ${esc(item.sku)}</div></div>
            <span class="badge low">Low</span>
          </div>
          <div class="item-meta"><span>📦 ${fmtInt(item.quantity)}</span><span>⚠️ Threshold: ${fmtInt(item.threshold ?? 5)}</span></div>
          <div class="progress-wrap">
            <div class="progress"><div class="progress-bar ${level}" style="width:${percent}%"></div></div>
            <span class="progress-label">${percent.toFixed(0)}%</span>
          </div>
          <div class="item-actions"><button type="button" class="btn primary" onclick="restockItem('${item.id}')">➕ Restock</button></div>
        </div>
      </div>`;
  }).join("");
}

export function renderExpiring() {
  const expiring = state.inventory
    .filter(i => { const e = expiryStatus(i.expiry); return e.level === "expiring" || e.level === "expired"; })
    .sort((a, b) => (daysUntilExpiry(a.expiry) ?? 999) - (daysUntilExpiry(b.expiry) ?? 999));
  const banner = $("expiry-banner"), bannerText = $("expiry-banner-text");
  if (banner && bannerText) {
    if (expiring.length) {
      const expiredCount = expiring.filter(i => expiryStatus(i.expiry).level === "expired").length;
      banner.classList.remove("hidden");
      bannerText.textContent = expiredCount
        ? `${expiredCount} item(s) already expired — ${expiring.length} total need attention.`
        : `${expiring.length} item(s) expiring within ${CONSTANTS.EXPIRY_WARNING_DAYS} days.`;
    } else banner.classList.add("hidden");
  }
  const list = $("expiring-list"); if (!list) return;
  if (!expiring.length) { list.innerHTML = `<div class="empty-state"><p>✅ No items expiring soon.</p></div>`; return; }
  list.innerHTML = expiring.map(item => {
    const exp = expiryStatus(item.expiry);
    const cls = exp.level === "expired" ? "expired" : "expiring";
    return `
      <div class="item-card ${exp.level === "expired" ? "expiring" : ""}">
        ${productImageHTML(item)}
        <div class="item-body">
          <div class="item-header">
            <div><div class="item-name">${esc(item.name)}</div><div class="item-sku">SKU: ${esc(item.sku)}</div></div>
            <span class="badge ${cls}">${exp.level === "expired" ? "Expired" : "Expiring"}</span>
          </div>
          <div class="item-meta"><span>⏰ ${esc(exp.label)}</span><span>📦 ${fmtInt(item.quantity)}</span></div>
          <div class="item-actions"><button type="button" class="btn primary" onclick="restockItem('${item.id}')">➕ Restock</button></div>
        </div>
      </div>`;
  }).join("");
}

/* =========================================================
   MOVEMENTS
   ========================================================= */
function getFilteredMovements() {
  const term = valOf($("movement-search")).toLowerCase().trim();
  const type = valOf($("movement-filter"));
  const range = valOf($("movement-range"));

  let list = state.movements.slice();

  if (type) list = list.filter(m => m.type === type);

  if (range) {
    const now = Date.now(); const dayMs = 24 * 60 * 60 * 1000;
    let cutoff = 0;
    if (range === "today") { const t = new Date(); t.setHours(0,0,0,0); cutoff = t.getTime(); }
    else if (range === "7") cutoff = now - 7 * dayMs;
    else if (range === "30") cutoff = now - 30 * dayMs;
    list = list.filter(m => (m.createdAt?.toMillis?.() ?? 0) >= cutoff);
  }

  if (term) {
    list = list.filter(m =>
      (m.itemName || "").toLowerCase().includes(term) ||
      (m.reason || "").toLowerCase().includes(term) ||
      (m.note || "").toLowerCase().includes(term) ||
      (m.createdAt?.toDate?.().toLocaleString() || "").toLowerCase().includes(term)
    );
  }
  return list;
}

const REASON_LABEL = { initial: "Initial stock", restock: "Restock", sale: "Sale", adjustment: "Adjustment" };

export function renderMovements() {
  const list = $("movements-list"); if (!list) return;
  const filtered = getFilteredMovements();
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><p>No matching stock movements.</p></div>`;
    return;
  }
  list.innerHTML = filtered.slice(0, 60).map(m => {
    const isIn = m.type === "in";
    const date = m.createdAt?.toDate?.().toLocaleString() ?? "—";
    const reasonLabel = REASON_LABEL[m.reason] || m.reason || "";
    const item = state.inventory.find(i => i.id === m.itemId) || {
      id: m.itemId, name: m.itemName, image: null
    };
    return `
    <div class="movement-row">
      ${productImageHTML(item, "sm")}
      <div class="movement-icon ${isIn ? "in" : "out"}">${isIn ? "⬇️" : "⬆️"}</div>
      <div class="movement-main">
        <div class="movement-name">${esc(m.itemName || "—")}</div>
        <div class="movement-meta">${date} · ${esc(reasonLabel)}${m.note ? " · " + esc(m.note) : ""}</div>
      </div>
      <div class="movement-qty ${isIn ? "in" : "out"}">${isIn ? "+" : "−"}${fmtInt(m.quantity)}</div>
      <div class="movement-actions">
        <button type="button" class="sale-action-btn receipt" onclick="viewMovement('${m.id}')" title="View">👁️</button>
        <button type="button" class="sale-action-btn" onclick="printMovement('${m.id}')" title="Print">🖨️</button>
        <button type="button" class="sale-action-btn delete" onclick="deleteMovement('${m.id}')" title="Delete">🗑️</button>
      </div>
    </div>`;
  }).join("");
}

export function viewMovement(id) {
  const m = state.movements.find(x => x.id === id);
  if (!m) { showToast("Movement not found ❌"); return; }
  state.currentMovementId = id;
  const isIn = m.type === "in";
  const date = m.createdAt?.toDate?.().toLocaleString() ?? "—";
  const reasonLabel = REASON_LABEL[m.reason] || m.reason || "—";
  const detail = $("movement-detail-content");
  if (detail) {
    detail.innerHTML = `
      <div class="mv-detail-row"><span class="mv-detail-label">Item</span><span class="mv-detail-value">${esc(m.itemName || "—")}</span></div>
      <div class="mv-detail-row"><span class="mv-detail-label">Type</span><span class="mv-detail-value ${isIn ? "in" : "out"}">${isIn ? "IN (+)" : "OUT (−)"}</span></div>
      <div class="mv-detail-row"><span class="mv-detail-label">Quantity</span><span class="mv-detail-value ${isIn ? "in" : "out"}">${isIn ? "+" : "−"}${fmtInt(m.quantity)}</span></div>
      <div class="mv-detail-row"><span class="mv-detail-label">Reason</span><span class="mv-detail-value">${esc(reasonLabel)}</span></div>
      <div class="mv-detail-row"><span class="mv-detail-label">Note</span><span class="mv-detail-value">${esc(m.note || "—")}</span></div>
      <div class="mv-detail-row"><span class="mv-detail-label">Date</span><span class="mv-detail-value">${esc(date)}</span></div>
      <div class="mv-detail-row"><span class="mv-detail-label">Record ID</span><span class="mv-detail-value"><code>${esc(m.id.slice(0, 12))}…</code></span></div>
    `;
  }
  $("movement-modal")?.classList.remove("hidden");
}
window.viewMovement = viewMovement;

export function printMovement(id) {
  const m = state.movements.find(x => x.id === id);
  if (!m) { showToast("Movement not found ❌"); return; }
  const isIn = m.type === "in";
  const date = m.createdAt?.toDate?.().toLocaleString() || "—";
  const reasonLabel = REASON_LABEL[m.reason] || m.reason || "—";
  printHTML(`
    <h1>Stock Movement Record</h1>
    <div class="meta">${CONSTANTS.STORE_NAME} · ${new Date().toLocaleString()}</div>
    <table>
      <tr><th style="width:180px">Item</th><td>${esc(m.itemName || "—")}</td></tr>
      <tr><th>Type</th><td>${isIn ? "IN (+)" : "OUT (−)"}</td></tr>
      <tr><th>Quantity</th><td>${isIn ? "+" : "−"}${fmtInt(m.quantity)}</td></tr>
      <tr><th>Reason</th><td>${esc(reasonLabel)}</td></tr>
      <tr><th>Note</th><td>${esc(m.note || "—")}</td></tr>
      <tr><th>Date</th><td>${esc(date)}</td></tr>
      <tr><th>Record ID</th><td>${esc(m.id)}</td></tr>
    </table>
  `, "Movement");
}
window.printMovement = printMovement;

export function printMovementsList() {
  const list = getFilteredMovements();
  if (!list.length) { showToast("No movements to print ❌"); return; }
  const rows = list.slice(0, 200).map(m => {
    const isIn = m.type === "in";
    return `<tr>
      <td>${esc(m.createdAt?.toDate?.().toLocaleString() || "—")}</td>
      <td>${esc(m.itemName || "—")}</td>
      <td>${isIn ? "IN (+)" : "OUT (−)"}</td>
      <td>${isIn ? "+" : "−"}${fmtInt(m.quantity)}</td>
      <td>${esc(REASON_LABEL[m.reason] || m.reason || "")}</td>
      <td>${esc(m.note || "")}</td>
    </tr>`;
  }).join("");
  printHTML(`
    <h1>In / Out History</h1>
    <div class="meta">${CONSTANTS.STORE_NAME} · Generated ${new Date().toLocaleString()} · ${list.length} record(s)</div>
    <table>
      <thead><tr><th>Date</th><th>Item</th><th>Type</th><th>Qty</th><th>Reason</th><th>Note</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `, "Movements");
}

export async function deleteMovement(id) {
  const m = state.movements.find(x => x.id === id);
  if (!m) { showToast("Movement not found ❌"); return; }
  const isIn = m.type === "in";
  const msg = `Delete this movement record?\n\n${m.itemName} · ${isIn ? "+" : "−"}${m.quantity} · ${m.reason || ""}\n\n⚠️ Stock quantity will NOT be reverted — this only removes the log entry.`;
  if (!confirm(msg)) return;
  try {
    await deleteDoc(doc(db, "movements", id));
    playSuccessSound();
    showToast("Movement deleted 🗑️");
  } catch (err) { showToast(`Failed: ${err.code || err.message} ❌`); }
}
window.deleteMovement = deleteMovement;

function closeMovementModal() {
  $("movement-modal")?.classList.add("hidden");
  state.currentMovementId = null;
}
function wireMovementModal() {
  $("movement-close")?.addEventListener("click", closeMovementModal);
  $("movement-close-btn")?.addEventListener("click", closeMovementModal);
  $("movement-modal")?.addEventListener("click", (e) => {
    if (e.target === $("movement-modal")) closeMovementModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("movement-modal")?.classList.contains("hidden")) closeMovementModal();
  });
  $("movement-delete-btn")?.addEventListener("click", async () => {
    if (!state.currentMovementId) return;
    const m = state.movements.find(x => x.id === state.currentMovementId);
    if (!m) { closeMovementModal(); return; }
    const isIn = m.type === "in";
    const msg = `Delete this movement record?\n\n${m.itemName} · ${isIn ? "+" : "−"}${m.quantity} · ${m.reason || ""}\n\n⚠️ Stock quantity will NOT be reverted — this only removes the log entry.`;
    if (!confirm(msg)) return;
    try {
      await deleteDoc(doc(db, "movements", m.id));
      playSuccessSound(); showToast("Movement deleted 🗑️"); closeMovementModal();
    } catch (err) { showToast(`Failed: ${err.code || err.message} ❌`); }
  });
  $("movement-print-btn")?.addEventListener("click", () => {
    if (state.currentMovementId) printMovement(state.currentMovementId);
  });
  $("movement-search")?.addEventListener("input", debounce(renderMovements, 150));
  $("movement-filter")?.addEventListener("change", renderMovements);
  $("movement-range")?.addEventListener("change", renderMovements);
  $("print-movements")?.addEventListener("click", printMovementsList);
}

/* =========================================================
   CATEGORY IMAGE API
   ========================================================= */
const IMG_KEYWORD_MAP = CONSTANTS.CATEGORY_IMAGE_API.keywordMap || {};
const IMG_DEFAULT_KW  = CONSTANTS.CATEGORY_IMAGE_API.keyword || "grocery product";

async function fetchWithTimeout(url, opts = {}, ms = CATEGORY_IMAGE_API.timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

function buildCategoryImageQuery(name) {
  const clean = String(name || "").trim().toLowerCase();
  if (!clean) return IMG_DEFAULT_KW;
  for (const [key, kw] of Object.entries(IMG_KEYWORD_MAP)) {
    if (clean.includes(key)) return kw;
  }
  return `${name} ${IMG_DEFAULT_KW}`;
}

async function fetchPexelsImages(query, perPage, apiKey) {
  if (!apiKey) throw new Error("Pexels API key missing");
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: apiKey } });
  if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`);
  const data = await res.json();
  return (data.photos || []).map(p => ({
    url: p.src?.large2x || p.src?.large || p.src?.original,
    thumb: p.src?.medium || p.src?.small || p.src?.tiny,
    credit: p.photographer || "Pexels",
    creditUrl: p.url,
    source: "Pexels"
  })).filter(x => x.url);
}

async function fetchUnsplashImages(query, perPage, apiKey) {
  if (!apiKey) throw new Error("Unsplash access key missing");
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Client-ID ${apiKey}` } });
  if (!res.ok) throw new Error(`Unsplash HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map(p => ({
    url: p.urls?.regular || p.urls?.full,
    thumb: p.urls?.small || p.urls?.thumb,
    credit: p.user?.name || "Unsplash",
    creditUrl: p.links?.html,
    source: "Unsplash"
  })).filter(x => x.url);
}

async function fetchOpenverseImages(query, perPage) {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${perPage}&mature=false`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Openverse HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map(r => ({
    url: r.url, thumb: r.thumbnail || r.url,
    credit: r.creator || r.source || "Openverse",
    creditUrl: r.foreign_landing_url || r.url,
    source: "Openverse"
  })).filter(x => x.url);
}

async function fetchWikipediaImages(query, perPage) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&generator=search` +
    `&gsrsearch=${encodeURIComponent(query)}&gsrlimit=${perPage}&gsrnamespace=6` +
    `&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=600&format=json&origin=*`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const data = await res.json();
  const pages = data.query?.pages || {};
  return Object.values(pages).map(p => {
    const info = p.imageinfo?.[0]; if (!info) return null;
    const artist = (info.extmetadata?.Artist?.value || "").replace(/<[^>]*>/g, "").trim();
    return {
      url: info.thumburl || info.url, thumb: info.thumburl || info.url,
      credit: artist || "Wikipedia",
      creditUrl: info.descriptionurl || info.url, source: "Wikipedia"
    };
  }).filter(Boolean);
}

async function fetchCategoryImages(query) {
  const cfg = CONSTANTS.CATEGORY_IMAGE_API;
  const perPage = cfg.perPage || 12;
  const keys = cfg.keys || {};

  const order = [];
  const push = (p) => { if (!order.includes(p)) order.push(p); };
  push((cfg.provider || "pexels").toLowerCase());
  push("pexels");
  push("unsplash");
  push("openverse");
  push("wikipedia");

  let lastErr = null;
  for (const p of order) {
    try {
      if (p === "pexels") {
        if (!keys.pexels) continue;
        return await fetchPexelsImages(query, perPage, keys.pexels);
      }
      if (p === "unsplash") {
        if (!keys.unsplash) continue;
        return await fetchUnsplashImages(query, perPage, keys.unsplash);
      }
      if (p === "openverse") return await fetchOpenverseImages(query, perPage);
      if (p === "wikipedia") return await fetchWikipediaImages(query, perPage);
    } catch (e) {
      lastErr = e;
      console.warn(`[cat image] ${p} failed →`, e.message);
    }
  }
  throw lastErr || new Error("No image provider available");
}

function setCatImageStatus(text, isError = false) {
  const el = $("cat-image-status"); if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("error", !!isError);
}
function renderCatImageSkeletons(n = 8) {
  const grid = $("cat-image-grid"); if (!grid) return;
  grid.innerHTML = Array.from({ length: n }).map(() => `<div class="cat-pick-skel"></div>`).join("");
}
function renderCatImageResults(results, currentUrl) {
  const grid = $("cat-image-grid"); if (!grid) return;
  if (!results.length) { grid.innerHTML = ""; setCatImageStatus("No photos found. Try a different search."); return; }
  grid.innerHTML = results.map((r, i) => `
    <button type="button"
            class="cat-pick-btn ${r.url === currentUrl ? "is-current" : ""}"
            data-index="${i}" title="${esc(r.credit || "")}">
      <img src="${esc(r.thumb || r.url)}" alt="" loading="lazy"
           onerror="this.style.opacity='.25'" />
    </button>
  `).join("");
  grid.querySelectorAll(".cat-pick-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const r = results[parseInt(btn.dataset.index, 10)];
      if (r) pickCategoryImage(r);
    });
  });
  const src = $("cat-image-source");
  if (src && results[0]) src.textContent = `Photos via ${results[0].source}`;
}
async function searchCategoryImages(query) {
  if (!query) query = IMG_DEFAULT_KW;
  renderCatImageSkeletons();
  setCatImageStatus(`Searching “${query}”…`);
  try {
    const results = await fetchCategoryImages(query);
    const cat = state.categories.find(c => c.id === state.catImageCategoryId);
    renderCatImageResults(results, cat?.image);
    setCatImageStatus(`${results.length} result${results.length !== 1 ? "s" : ""} — tap a photo to use it.`);
  } catch (err) {
    console.warn("[cat image] search failed:", err);
    $("cat-image-grid").innerHTML = "";
    setCatImageStatus("Couldn't load photos. Check your key / connection, or try another search.", true);
  }
}
async function pickCategoryImage(result) {
  if (!state.catImageCategoryId) return;
  try {
    await updateDoc(doc(db, "categories", state.catImageCategoryId), {
      image: result.url, imageThumb: result.thumb || result.url,
      imageCredit: result.credit || "", imageCreditUrl: result.creditUrl || "",
      imageSource: result.source || "", imageUpdatedAt: serverTimestamp()
    });
    playSuccessSound(); showToast("Category image updated ✅");
    closeCategoryImagePicker();
  } catch (err) { showToast(`Failed: ${err.code || err.message} ❌`); }
}
async function autoAssignCategoryImage(categoryId, name) {
  if (!name) return;
  try {
    const results = await fetchCategoryImages(buildCategoryImageQuery(name));
    if (!results.length) return;
    const top = results[0];
    await updateDoc(doc(db, "categories", categoryId), {
      image: top.url, imageThumb: top.thumb || top.url,
      imageCredit: top.credit || "", imageCreditUrl: top.creditUrl || "",
      imageSource: top.source || "", imageUpdatedAt: serverTimestamp()
    });
    showToast(`Image added for “${name}” 📷`);
  } catch (e) { console.warn("[cat image] auto-assign skipped:", e.message); }
}
function openCategoryImagePicker(categoryId) {
  const cat = state.categories.find(c => c.id === categoryId);
  if (!cat) { showToast("Category not found ❌"); return; }
  state.catImageCategoryId = categoryId;
  const t = $("cat-image-title"); if (t) t.textContent = `Image for “${cat.name}”`;
  const query = buildCategoryImageQuery(cat.name);
  const q = $("cat-image-query"); if (q) q.value = query;
  $("cat-image-modal")?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  searchCategoryImages(query);
}
function closeCategoryImagePicker() {
  $("cat-image-modal")?.classList.add("hidden");
  document.body.style.overflow = "";
  state.catImageCategoryId = null;
}

/* =========================================================
   RENDER — Categories grid (modern + bulk select)
   ========================================================= */
function categoryThumbHTML(cat) {
  const src = cat.imageThumb || cat.image;
  const letter = (cat.name || "?").charAt(0).toUpperCase();
  const bg = fallbackColorFor(cat.name);
  return `
    <div class="cat-thumb-fallback" style="background:${bg}">${letter}</div>
    ${src ? `<img class="cat-thumb-img" src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()" />` : ""}
  `;
}

/* ---------- Selection state ---------- */
const selectedCategories = new Set();

/* ---------- Bulk bar injection ---------- */
function ensureCategoriesBulkBar() {
  if (document.getElementById("categories-bulk-bar")) return;

  const grid = document.getElementById("category-grid");
  if (!grid) return;

  const bar = document.createElement("div");
  bar.id = "categories-bulk-bar";
  bar.className = "history-bulk-bar hidden";
  bar.innerHTML = `
    <label class="bulk-select-all">
      <input type="checkbox" id="categories-select-all" />
      <span>Select all</span>
    </label>
    <span id="categories-selected-count" class="bulk-count">0 selected</span>
    <button type="button" class="btn danger sm" id="categories-delete-selected" disabled>🗑️ Delete selected</button>
  `;
  grid.insertAdjacentElement("beforebegin", bar);

  /* Wire once */
  bar.querySelector("#categories-select-all")?.addEventListener("change", (e) => {
    const checked = e.target.checked;
    document.querySelectorAll("#category-grid .cat-row-checkbox").forEach(cb => {
      cb.checked = checked;
      const id = cb.dataset.catId;
      if (checked) selectedCategories.add(id);
      else         selectedCategories.delete(id);
      cb.closest(".category-card")?.classList.toggle("is-selected", checked);
    });
    updateCategoriesBulkUI();
  });

  bar.querySelector("#categories-delete-selected")?.addEventListener("click", () => {
    if (!selectedCategories.size) return;
    deleteCategoriesBulk([...selectedCategories]);
  });
}

function updateCategoriesBulkUI() {
  const bar       = document.getElementById("categories-bulk-bar");
  const countEl   = document.getElementById("categories-selected-count");
  const delBtn    = document.getElementById("categories-delete-selected");
  const selectAll = document.getElementById("categories-select-all");
  const grid      = document.getElementById("category-grid");

  const hasRows = !!(grid && grid.querySelector(".category-card"));
  if (bar) bar.classList.toggle("hidden", !hasRows);

  if (countEl) countEl.textContent = `${selectedCategories.size} selected`;
  if (delBtn)  delBtn.disabled = selectedCategories.size === 0;

  if (selectAll && grid) {
    const cbs = [...grid.querySelectorAll(".cat-row-checkbox")];
    const allChecked = cbs.length > 0 && cbs.every(cb => cb.checked);
    const anyChecked = cbs.some(cb => cb.checked);
    selectAll.checked = allChecked;
    selectAll.indeterminate = !allChecked && anyChecked;
  }
}

/* ---------- Bulk delete ---------- */
async function deleteCategoriesBulk(ids) {
  if (!ids?.length) return;
  const n = ids.length;
  if (!confirm(`Delete ${n} categor${n !== 1 ? "ies" : "y"}?\n\nItems currently assigned to them will keep their category name as plain text.`)) return;

  const delBtn = document.getElementById("categories-delete-selected");
  if (delBtn) delBtn.disabled = true;

  try {
    const batch = writeBatch(db);
    ids.forEach(id => batch.delete(doc(db, "categories", id)));
    await settleWrite(batch.commit(), "Delete categories");
    selectedCategories.clear();
    playSuccessSound();
    showToast(`Deleted ${n} categor${n !== 1 ? "ies" : "y"} 🗑️`);
  } catch (err) {
    showToast(`Failed: ${err.code || err.message} ❌`);
  } finally {
    updateCategoriesBulkUI();
  }
}

/* ---------- Main render ---------- */
export function renderCategories() {
  const grid = document.getElementById("category-grid");
  if (!grid) return;

  /* Prune stale selections (deleted or filtered out) */
  const currentIds = new Set(state.categories.map(c => c.id));
  [...selectedCategories].forEach(id => {
    if (!currentIds.has(id)) selectedCategories.delete(id);
  });

  if (!state.categories.length) {
    grid.innerHTML = `<div class="empty-state"><p>🗂️ No categories yet — add one above.</p></div>`;
    updateCategoriesBulkUI();
    return;
  }

  grid.innerHTML = state.categories.map(cat => {
    const count = state.inventory.filter(i => i.category === cat.name).length;
    const isSelected = selectedCategories.has(cat.id);
    const creditTitle = cat.imageCredit ? `Image: ${cat.imageCredit}` : "Change image";

    return `
      <div class="category-card ${isSelected ? "is-selected" : ""}" data-cat-id="${esc(cat.id)}">
        <label class="cat-row-check" title="Select category">
          <input type="checkbox"
                 class="cat-row-checkbox"
                 data-cat-id="${esc(cat.id)}"
                 ${isSelected ? "checked" : ""} />
        </label>

        <button type="button" class="cat-thumb"
                data-cat-id="${esc(cat.id)}"
                title="${esc(creditTitle)}"
                aria-label="Change image for ${esc(cat.name)}">
          ${categoryThumbHTML(cat)}
          <span class="cat-thumb-edit">✎</span>
        </button>

        <div class="cat-info">
          <div class="cat-name" title="${esc(cat.name)}">${esc(cat.name)}</div>
          <div class="cat-count">
            ${fmtInt(count)} item${count !== 1 ? "s" : ""}
            ${cat.imageCredit ? `<span class="cat-credit-inline">· 📷 ${esc(cat.imageCredit)}</span>` : ""}
          </div>
        </div>

        <button type="button" class="cat-delete-btn"
                data-cat-id="${esc(cat.id)}"
                title="Delete category"
                aria-label="Delete ${esc(cat.name)}">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
               stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          </svg>
        </button>
      </div>
    `;
  }).join("");

  /* Wire checkboxes */
  grid.querySelectorAll(".cat-row-checkbox").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.catId;
      if (cb.checked) selectedCategories.add(id);
      else            selectedCategories.delete(id);
      cb.closest(".category-card")?.classList.toggle("is-selected", cb.checked);
      updateCategoriesBulkUI();
    });
  });

  /* Wire thumb → image picker */
  grid.querySelectorAll(".cat-thumb").forEach(btn => {
    btn.addEventListener("click", () => openCategoryImagePicker(btn.dataset.catId));
  });

  /* Wire per-row delete */
  grid.querySelectorAll(".cat-delete-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteCategory(btn.dataset.catId);
    });
  });

  updateCategoriesBulkUI();
}

export async function deleteCategory(id) {
  const cat = state.categories.find(c => c.id === id);
  const label = cat?.name ? `"${cat.name}"` : "this category";
  if (!confirm(`Delete ${label}?`)) return;
  try {
    await deleteDoc(doc(db, "categories", id));
    selectedCategories.delete(id);
    playSuccessSound();
    showToast("Category deleted 🗑️");
  } catch (err) { showToast(`Failed: ${err.code || err.message} ❌`); }
}
window.deleteCategory = deleteCategory;

/* =========================================================
   CATEGORY CRUD
   ========================================================= */
function wireCategoryForm() {
  const form = $("category-form"); if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const wsId = myWorkspace();
    if (!wsId) { showToast("Workspace not ready ❌"); return; }
    const name = valOf($("new-category")).trim();
    if (!name) return;
    if (state.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
      showToast("Category already exists ❌"); return;
    }
    try {
      const ref = await addDoc(collection(db, "categories"), {
        name, workspaceId: wsId, createdAt: serverTimestamp()
      });
      if ($("new-category")) $("new-category").value = "";
      showToast("Category added ✅ — fetching image…");
      autoAssignCategoryImage(ref.id, name);
    } catch (err) { showToast(`Failed: ${err.code || err.message} ❌`); }
  });
}

/* =========================================================
   SCANNER
   ========================================================= */
function getScannerFormats() {
  const F = window.Html5QrcodeSupportedFormats;
  if (!F) return null;
  return [F.QR_CODE, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39].filter(v => v !== undefined && v !== null);
}
function setScannerStatus(html, type = "") {
  const el = $("scanner-status"); if (!el) return;
  el.innerHTML = html;
  el.classList.remove("success", "error");
  if (type) el.classList.add(type);
}
function checkCameraEnvironment() {
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: "This browser doesn't support camera. Type the barcode below." };
  const isHttps = location.protocol === "https:";
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  const isFile  = location.protocol === "file:";
  if (!isHttps && !isLocal && !isFile) return { ok: false, reason: `Camera needs <b>HTTPS</b> or <b>localhost</b>.<br>Type the barcode below.` };
  return { ok: true };
}
function scannerErrorText(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  return `${err.name || ""} ${err.message || ""}`.trim();
}
function isPermissionError(err) { return /NotAllowed|PermissionDenied|Permission denied/i.test(scannerErrorText(err)); }
function cameraErrorMessage(err) {
  const t = scannerErrorText(err);
  if (/NotAllowed|PermissionDenied|Permission denied/i.test(t)) return "🚫 Camera permission <b>denied</b>.";
  if (/NotFound|DevicesNotFound|no camera/i.test(t)) return "📷 <b>No camera found</b>. Type the barcode below.";
  if (/NotReadable|TrackStart/i.test(t)) return "⚠️ Camera is <b>busy</b> — another app is using it.";
  if (/Overconstrained|ConstraintNotSatisfied/i.test(t)) return "⚠️ Camera settings unsupported.";
  if (/SecurityError/i.test(t)) return "🔒 Browser blocked camera. Use HTTPS or localhost.";
  return "❌ Camera error: <code>" + esc(t.slice(0, 80)) + "</code>";
}
function flashScanFrame() {
  const v = $("scanner-view"); if (!v) return;
  v.classList.add("matched");
  clearTimeout(state.scanner.matchFlashTimer);
  state.scanner.matchFlashTimer = setTimeout(() => v.classList.remove("matched"), 600);
}

export function openScanner(target, onCustomResult = null) {
  const S = state.scanner;
  if (S.opening) return;
  if (S.state !== SCANNER_STATE.IDLE) return;
  const modal = $("scanner-modal");
  if (modal && !modal.classList.contains("hidden")) return;

  S.opening = true;
  S.target = target;
  S.onCustomResult = typeof onCustomResult === "function" ? onCustomResult : null;
  S.scanHandling = false;
  const session = ++S.session;

  const title = $("scanner-title");
  if (title) title.textContent =
    target === "barcode"        ? "Scan Product Barcode" :
    target === "sale"           ? "Scan Items for POS"  :
    target === "gcash-customer" ? "Scan Customer QR"    :
                                  "Scan Barcode";

  if ($("scanner-manual-input")) $("scanner-manual-input").value = "";
  const view = $("scanner-view");
  if (view) {
    view.style.setProperty("--scan-w", (SCAN_BOX.w * 100) + "%");
    view.style.setProperty("--scan-h", (SCAN_BOX.h * 100) + "%");
    view.classList.remove("matched");
  }
  if (modal) modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";

  const env = checkCameraEnvironment();
  if (!env.ok) { setScannerStatus(env.reason, "error"); setTimeout(() => $("scanner-manual-input")?.focus(), 250); S.opening = false; return; }
  if (typeof Html5Qrcode === "undefined") { setScannerStatus("Scanner library not loaded. Type the barcode below.", "error"); S.opening = false; return; }
  setScannerStatus("Starting camera…");
  requestAnimationFrame(() => { startCameraNow(session).catch(e => console.warn("[Scanner] start:", e)); });
}

async function startCameraNow(session) {
  const readerEl = document.getElementById("scanner-reader");
  const viewEl = document.getElementById("scanner-view");
  if (!readerEl) { state.scanner.opening = false; return; }
  let rect = (viewEl || readerEl).getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) {
    await new Promise(r => setTimeout(r, 200));
    if (session !== state.scanner.session) return;
    rect = (viewEl || readerEl).getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) { setScannerStatus("Scanner viewport has no size.", "error"); state.scanner.opening = false; return; }
  }
  await startScanning(readerEl, session);
}

async function startScanning(readerEl, session) {
  try { readerEl.innerHTML = ""; } catch {}
  let inst;
  try {
    const opts = { verbose: false, useBarCodeDetectorIfSupported: true };
    const formats = getScannerFormats();
    if (formats?.length) opts.formatsToSupport = formats;
    inst = new Html5Qrcode("scanner-reader", opts);
  } catch (e) { setScannerStatus("Scanner init failed.", "error"); state.scanner.opening = false; state.scanner.state = SCANNER_STATE.IDLE; return; }
  state.scanner.instance = inst;
  state.scanner.state = SCANNER_STATE.STARTING;

  const baseCfg = {
    fps: SCAN_FPS, disableFlip: true,
    qrbox: (vw, vh) => ({ width: Math.max(120, Math.floor(vw * SCAN_BOX.w)), height: Math.max(80, Math.floor(vh * SCAN_BOX.h)) })
  };
  const onDecode = (text) => onScanSuccess(text);
  const onMiss = () => {};
  const attempts = [
    () => inst.start({ facingMode: "environment" }, { ...baseCfg, videoConstraints: SCAN_VIDEO }, onDecode, onMiss),
    async () => {
      const cams = await Html5Qrcode.getCameras();
      if (!cams?.length) throw "NotFoundError: no camera";
      const cam = cams.find(c => /back|rear|environment/i.test(c.label || "")) || cams[0];
      await inst.start(cam.id, baseCfg, onDecode, onMiss);
    },
    () => inst.start({ facingMode: "user" }, baseCfg, onDecode, onMiss)
  ];
  let lastErr = null;
  for (const attempt of attempts) {
    if (session !== state.scanner.session) return;
    try {
      await attempt();
      if (session !== state.scanner.session) { try { await inst.stop(); } catch {} try { inst.clear(); } catch {} return; }
      state.scanner.state = SCANNER_STATE.RUNNING;
      state.scanner.opening = false;
      const invCount = state.inventory.length;
      const hint = invCount ? `${invCount} item${invCount !== 1 ? "s" : ""} loaded` : "⚠️ inventory still loading…";
      const statusMsg = state.scanner.target === "sale"
        ? `Point at a barcode. Keep scanning to add more. (${hint})`
        : state.scanner.target === "gcash-customer"
          ? "Point the camera at the customer's QR code…"
          : `Point the camera at a barcode… (${hint})`;
      setScannerStatus(statusMsg);
      return;
    } catch (err) {
      lastErr = err;
      if (isPermissionError(err)) break;
    }
  }
  if (session !== state.scanner.session) return;
  state.scanner.opening = false;
  state.scanner.state = SCANNER_STATE.IDLE;
  state.scanner.instance = null;
  setScannerStatus(cameraErrorMessage(lastErr), "error");
  setTimeout(() => $("scanner-manual-input")?.focus(), 200);
}

async function shutdownScanner() {
  const S = state.scanner;
  S.session++;
  const inst = S.instance;
  S.instance = null;
  S.state = SCANNER_STATE.STOPPING;
  S.onCustomResult = null;
  const readerEl = document.getElementById("scanner-reader");
  if (inst) { try { await inst.stop(); } catch {} try { inst.clear?.(); } catch {} }
  if (readerEl) {
    try {
      readerEl.querySelectorAll("video").forEach(v => {
        try { if (v.srcObject) v.srcObject.getTracks().forEach(t => t.stop()); v.pause(); v.srcObject = null; } catch {}
      });
      readerEl.innerHTML = "";
    } catch {}
  }
  S.state = SCANNER_STATE.IDLE;
  S.opening = false;
  S.scanHandling = false;
  S.lastScanCode = "";
  S.lastScanTime = 0;
}

export function forceCloseScanner() {
  $("scanner-modal")?.classList.add("hidden");
  document.body.style.overflow = "";
  shutdownScanner().catch(() => {});
}
function closeScanner() { forceCloseScanner(); }

async function retryScanner() {
  await shutdownScanner();
  await new Promise(r => setTimeout(r, 350));
  openScanner(state.scanner.target || "sale");
}

function onScanSuccess(decodedText) {
  const S = state.scanner;
  if (S.scanHandling) return;
  const modal = $("scanner-modal");
  if (!modal || modal.classList.contains("hidden")) return;
  const code = String(decodedText || "").trim();
  if (!code) return;
  const now = Date.now();
  if (code === S.lastScanCode && (now - S.lastScanTime) < SCAN_COOLDOWN_MS) return;
  S.lastScanCode = code; S.lastScanTime = now; S.scanHandling = true;
  flashScanFrame();
  try { handleScanResult(code); }
  finally { setTimeout(() => { state.scanner.scanHandling = false; }, 350); }
}

function handleScanResult(text) {
  const code = String(text || "").trim();
  if (!code) return;

  /* Custom handler takes precedence (used by GCash customer-QR scanning) */
  if (typeof state.scanner.onCustomResult === "function") {
    const handler = state.scanner.onCustomResult;
    state.scanner.onCustomResult = null;
    try { handler(code); }
    catch (e) { console.error("[scanner custom handler]", e); }
    return;
  }

  if (state.scanner.target === "barcode") {
    if ($("item-barcode")) $("item-barcode").value = code;
    playSuccessSound();
    setScannerStatus("✅ Barcode set: " + code, "success");
    setTimeout(() => forceCloseScanner(), 500);
    return;
  }

  if (state.scanner.target === "sale") {
    import("./pos.js").then(({ handleBarcodeScan }) => {
      const result = handleBarcodeScan(code, { silent: true });

      if (!result.ok) {
        playErrorSound();
        let msg = "❌ Scan failed";
        if (result.reason === "not_found")          msg = `❌ No match for: ${code}`;
        else if (result.reason === "out_of_stock")  msg = `⚠️ Out of stock: ${result.item?.name || code}`;
        else if (result.reason === "insufficient_stock") msg = `⚠️ Not enough stock: ${result.item?.name || code}`;
        else if (result.reason === "loading")       msg = "⚠️ Inventory still loading.";
        setScannerStatus(msg, "error");
        return;
      }

      playSuccessSound();
      const cartCount = state.posCart.reduce((s, c) => s + c.qty, 0);
      setScannerStatus(
        `✅ Added: ${result.item.name} · Cart: ${cartCount} item${cartCount !== 1 ? "s" : ""}`,
        "success"
      );
    });
  }
}

function wireScanner() {
  $("scan-barcode-btn")?.addEventListener("click", () => openScanner("barcode"));
  $("scan-sale-btn")?.addEventListener("click", () => openScanner("sale"));
  $("scanner-close")?.addEventListener("click", closeScanner);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("scanner-modal")?.classList.contains("hidden")) closeScanner();
  });
  $("scanner-modal")?.addEventListener("click", (e) => { if (e.target === $("scanner-modal")) closeScanner(); });
  $("scanner-manual-btn")?.addEventListener("click", () => {
    const val = valOf($("scanner-manual-input")).trim();
    if (val) handleScanResult(val);
  });
  $("scanner-manual-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("scanner-manual-btn")?.click(); }
  });
  $("scanner-retry-btn")?.addEventListener("click", retryScanner);
  if ($("scanner-upload-btn") && $("scanner-upload-input")) {
    $("scanner-upload-btn").addEventListener("click", () => $("scanner-upload-input").click());
    $("scanner-upload-input").addEventListener("change", async (e) => {
      const file = e.target.files?.[0]; if (!file) return; e.target.value = "";
      setScannerStatus("Scanning image…");
      try {
        await shutdownScanner();
        await new Promise(r => setTimeout(r, 200));
        $("scanner-modal")?.classList.remove("hidden");
        await new Promise(r => requestAnimationFrame(r));
        const temp = new Html5Qrcode("scanner-reader", { verbose: false });
        const result = await temp.scanFile(file, true);
        try { temp.clear(); } catch {}
        handleScanResult(result);
        setTimeout(() => forceCloseScanner(), 700);
      } catch { setScannerStatus("❌ No barcode found in that image.", "error"); }
    });
  }
}

/* =========================================================
   INIT
   ========================================================= */
export function initInventory() {
  wirePhotoInputs();
  wireDiscountPreview();
  wireItemForm();
  wireRestock();
  wireMovementModal();
  wireScanner();
  wireCategoryForm();
  wireImport();
  wireAutoSync();
  ensureCategoriesBulkBar();
  $("search-input")?.addEventListener("input", debounce(renderInventory, 150));
  $("filter-category")?.addEventListener("change", renderInventory);
  $("dash-search")?.addEventListener("input", debounce(renderDashboardInventory, 150));
  $("expiry-banner-btn")?.addEventListener("click", () => {
    $("expiring-list")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

/* =========================================================
   EXCEL IMPORT / UPDATE
   ========================================================= */
const IMPORT_COLUMNS = [
  "Name", "SKU", "Barcode", "Category",
  "Quantity", "Cost", "Price",
  "Discount%", "Discount price",
  "Expiry", "Threshold"
];

let _importRows = [];

function openImportModal() {
  _importRows = [];
  const fileInput = $("import-file-input");
  if (fileInput) fileInput.value = "";
  const fileName = $("import-file-name");
  if (fileName) fileName.textContent = "No file selected";
  const preview = $("import-preview");
  if (preview) { preview.classList.add("hidden"); preview.innerHTML = ""; }
  const confirmBtn = $("import-confirm-btn");
  if (confirmBtn) confirmBtn.disabled = true;
  $("import-modal")?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  updateAutoSyncUI();
}

function closeImportModal() {
  $("import-modal")?.classList.add("hidden");
  document.body.style.overflow = "";
  _importRows = [];
}

async function parseExcelFile(file) {
  if (typeof XLSX === "undefined") throw new Error("Excel library not loaded");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error("No sheets found");
  return XLSX.utils.sheet_to_json(ws, { defval: "" });
}

/* =========================================================
   SMART COLUMN MATCHER — with optional exclusion patterns
   ---------------------------------------------------------
   Exact match first, then partial. The optional `exclude`
   list prevents columns like "Discount price" from being
   matched when the caller is looking for "Price".
   ========================================================= */
function findColumnKey(raw, candidates, excludeSubstrings = []) {
  const keys = Object.keys(raw || {});
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const excludes = excludeSubstrings.map(norm).filter(Boolean);

  const isExcluded = (k) => {
    const kn = norm(k);
    return excludes.some(ex => kn.includes(ex));
  };

  // 1) Exact match
  for (const cand of candidates) {
    const n = norm(cand);
    if (!n) continue;
    const exact = keys.find(k => !isExcluded(k) && norm(k) === n);
    if (exact) return exact;
  }

  // 2) Partial match — still respects the exclusion list
  for (const cand of candidates) {
    const n = norm(cand);
    if (!n) continue;
    const partial = keys.find(k => !isExcluded(k) && norm(k).includes(n));
    if (partial) return partial;
  }
  return null;
}

/* =========================================================
   DISCOUNT PERCENTAGE COLUMN MATCHER
   ---------------------------------------------------------
   Explicit. Never fuzzy-matches "Discount price" because
   that header always contains "price" / "amount" / currency
   and is rejected by the guard below.
   ========================================================= */
function findDiscountPercentColumn(raw) {
  if (!raw) return null;
  const keys = Object.keys(raw);
  const norm = (s) => String(s || "").trim().toLowerCase();

  // ---- 1) Exact whitelist ----
  const wanted = [
    "%", "pct", "percent", "% off", "percent off",
    "disc%", "disc %", "disc.%", "disc. %",
    "discount%", "discount %", "discount.%", "discount. %",
    "discount percent", "discountpercent", "discount_percent",
    "discount rate", "discountrate", "discount_rate",
    "disc pct", "discount pct", "disc_pct", "discount_pct",
    "disc pct.", "discount pct.",
    "discount (%)", "disc (%)", "discount(%)", "disc(%)",
    "discount percentage", "disc percentage"
  ];
  for (const w of wanted) {
    const hit = keys.find(k => norm(k) === w);
    if (hit) return hit;
  }

  // ---- 2) Regex fallback — strictly excludes anything
  //        that could be a "price" / "amount" / currency column.
  for (const k of keys) {
    const t = norm(k);

    // Reject price/amount/peso/₱/php columns first
    if (/(price|amount|peso|php|₱)/i.test(t)) continue;

    // Starts with disc/discount AND contains %/percent/rate/pct
    if (/^(disc|discount)\b/.test(t) && /(%|percent|rate|pct)/.test(t)) return k;

    // Bare "%" or "% off"
    if (/^%/.test(t)) return k;

    // Starts with percent/pct
    if (/^(percent|pct)\b/.test(t)) return k;
  }

  return null;
}

/* =========================================================
   NORMALIZE IMPORT ROW
   ---------------------------------------------------------
   - Price is the base selling price (never a discounted one).
   - Discount is derived ONLY from the % column.
   - Handles Excel percentage cells stored as decimals
     (0.1 → 10%, 0.25 → 25%) so a "10%" cell never becomes
     a 0.1% discount.
   - If the % column is missing, blank, null, or 0, both
     discount and discountPrice are set to 0 explicitly —
     this clears any previous discount on update.
   ========================================================= */
function normalizeImportRow(raw) {
  const getByCandidates = (candidates, exclude = []) => {
    const key = findColumnKey(raw, candidates, exclude);
    return key != null ? raw[key] : "";
  };

  /* Parse numbers, handling Excel decimals & thousand separators */
  const numOf = (v) => {
    if (v === "" || v == null) return null;
    if (typeof v === "number" && isFinite(v)) return v;
    const cleaned = String(v).replace(/,/g, "").replace(/[^0-9.\-]/g, "");
    if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
    const n = Number(cleaned);
    return isNaN(n) ? null : n;
  };

  /* Percentage parser:
       number 0.10  → 10     (Excel decimal form)
       string "10%" → 10
       string "0.1" → 10     (assume decimal form)
       number 10    → 10
       number 0     → 0
       blank/null   → null   (no discount) */
  const pctOf = (v) => {
    const rawN = numOf(v);
    if (rawN == null) return null;
    if (rawN === 0) return 0;
    /* If the parsed value is strictly between 0 and 1, Excel is
       almost certainly handing us the decimal form of a percent. */
    if (rawN > 0 && rawN < 1) return Number((rawN * 100).toFixed(4));
    return rawN;
  };

  /* ---------- Core fields ---------- */
  const name      = String(getByCandidates(["Name", "Product", "Product Name", "Item"]) || "").trim();
  const sku       = String(getByCandidates(["SKU", "Sku", "Code", "Item Code"]) || "").trim();
  const barcode   = String(getByCandidates(["Barcode", "Bar Code", "EAN", "UPC", "GTIN"]) || "").trim();
  const category  = String(getByCandidates(["Category", "Cat"]) || "").trim();
  const quantity  = numOf(getByCandidates(["Quantity", "Qty", "Stock", "On Hand"])) || 0;
  const cost      = numOf(getByCandidates(["Cost", "Cost Price", "Puhunan", "Buy Price"])) || 0;

  /* ---------------------------------------------------------
     PRICE — explicitly reject any column containing
     "discount", "disc", "sale", or "promo". This guarantees
     we never read the discounted price as the base price.
     --------------------------------------------------------- */
  const price = numOf(getByCandidates(
    [
      "Selling Price", "SellingPrice", "Selling",
      "Price", "SRP",
      "Orig Price", "OrigPrice",
      "Original Price", "OriginalPrice"
    ],
    ["discount", "disc", "discounted", "sale", "promo"]
  )) || 0;

  const expiry    = String(getByCandidates(["Expiry", "Expiry Date", "Expiration", "Best Before"]) || "").trim();
  const threshold = numOf(getByCandidates(["Threshold", "Min Stock", "Low Stock", "Reorder Point"])) || 5;

  /* ---------------------------------------------------------
     DISCOUNT — the % column is authoritative.
     --------------------------------------------------------- */
  const discPctKey = findDiscountPercentColumn(raw);
  const rawPct = discPctKey != null ? raw[discPctKey] : "";
  const pctVal = pctOf(rawPct);

  let discount = 0;
  let discountPrice = 0;

  if (pctVal != null && pctVal > 0 && price > 0) {
    const cappedPct = Math.min(100, pctVal);
    discount = Number(cappedPct.toFixed(4));
    discountPrice = Number((price * (1 - cappedPct / 100)).toFixed(2));
  }
  /* else: discount / discountPrice remain 0 → clears any previous discount */

  /* Debug — visible in browser console */
  try {
    if (console?.debug) {
      console.debug("[import] row:", name || "(no name)",
        "| pctKey:", discPctKey,
        "| rawPct:", JSON.stringify(rawPct),
        "| pctVal:", pctVal,
        "| price:", price,
        "| discount:", discount,
        "| discountPrice:", discountPrice);
    }
  } catch {}

  return {
    name, sku, barcode, category, quantity, cost, price,
    discount,
    discountType: "percent",
    discountPrice,
    expiry, threshold
  };
}

/* =========================================================
   PLAN IMPORT
   ---------------------------------------------------------
   Matches existing items by SKU, then Barcode, then Name.
   This ensures rows without a SKU still update the existing
   Firestore document instead of creating a duplicate — which
   is what left the old discount in place previously.
   ========================================================= */
function planImport(rows) {
  const skuMap     = new Map();
  const barcodeMap = new Map();
  const nameMap    = new Map();

  state.inventory.forEach(i => {
    if (i.sku)     skuMap.set(String(i.sku).trim().toLowerCase(), i);
    if (i.barcode) barcodeMap.set(String(i.barcode).trim().toLowerCase(), i);
    if (i.name)    nameMap.set(String(i.name).trim().toLowerCase(), i);
  });

  return rows.map((r, idx) => {
    const errors = [];
    if (!r.name) errors.push("Name required");
    if (!r.category) errors.push("Category required");
    if (!r.price || r.price <= 0) errors.push("Price must be > 0");

    let existing = null;
    let matchType = "";

    if (r.sku) {
      const hit = skuMap.get(r.sku.toLowerCase());
      if (hit) { existing = hit; matchType = "sku"; }
    }
    if (!existing && r.barcode) {
      const hit = barcodeMap.get(r.barcode.toLowerCase());
      if (hit) { existing = hit; matchType = "barcode"; }
    }
    if (!existing && r.name) {
      const hit = nameMap.get(r.name.toLowerCase());
      if (hit) { existing = hit; matchType = "name"; }
    }

    const action = existing ? "update" : "create";
    if (!existing && !r.sku && !r.barcode && !r.name) {
      errors.push("Need SKU, Barcode, or Name");
    }

    return {
      ...r,
      _row: idx + 2,
      _action: action,
      _errors: errors,
      _existingId: existing?.id || null,
      _matchType: matchType
    };
  });
}

function renderImportPreview(planned) {
  const preview = $("import-preview");
  if (!preview) return;
  const valid = planned.filter(p => !p._errors.length);
  const invalid = planned.filter(p => p._errors.length);
  const creates = valid.filter(p => p._action === "create").length;
  const updates = valid.filter(p => p._action === "update").length;

  const rowsHTML = planned.slice(0, 30).map(p => {
    const cls = p._errors.length ? "err" : (p._action === "update" ? "upd" : "new");
    const label = p._errors.length ? `❌ ${p._errors.join(", ")}` : (p._action === "update" ? "↻ Update" : "＋ New");
    const discBadge = (p.discountPrice && p.discountPrice > 0)
      ? `<span class="import-row-disc">💥 ${p.discount ? Math.round(p.discount) + "% · " : ""}${fmtMoney(p.discountPrice)}</span>`
      : "";
    return `<div class="import-row ${cls}">
      <span class="import-row-num">#${p._row}</span>
      <span class="import-row-name">${esc(p.name || "(no name)")}</span>
      <span class="import-row-sku">${esc(p.sku || "—")}</span>
      ${discBadge}
      <span class="import-row-action">${label}</span>
    </div>`;
  }).join("");

  preview.classList.remove("hidden");
  preview.innerHTML = `
    <div class="import-summary">
      <span>✅ <strong>${creates}</strong> new</span>
      <span>↻ <strong>${updates}</strong> updates</span>
      ${invalid.length ? `<span>❌ <strong>${invalid.length}</strong> skipped</span>` : ""}
    </div>
    <div class="import-rows">${rowsHTML}${planned.length > 30 ? `<div class="import-more">… and ${planned.length - 30} more rows</div>` : ""}</div>
  `;

  const confirmBtn = $("import-confirm-btn");
  if (confirmBtn) confirmBtn.disabled = valid.length === 0;
}

async function handleImportFile(file) {
  if (!file) return;
  try {
    const raw = await parseExcelFile(file);
    if (!raw.length) { showToast("Excel file is empty ❌"); return; }
    const normalized = raw.map(normalizeImportRow);
    const planned = planImport(normalized);
    _importRows = planned;
    renderImportPreview(planned);
    const nameEl = $("import-file-name");
    if (nameEl) nameEl.textContent = `${file.name} · ${planned.length} row${planned.length !== 1 ? "s" : ""}`;
    showToast(`Preview ready · ${planned.filter(p => !p._errors.length).length} valid ✅`);
  } catch (err) {
    console.error("[import] parse failed:", err);
    showToast(`Import failed: ${err.message} ❌`);
  }
}

async function commitImport() {
  const valid = _importRows.filter(p => !p._errors.length);
  if (!valid.length) { showToast("No valid rows to import ❌"); return; }

  const wsId = myWorkspace();
  if (!wsId) { showToast("Workspace not ready ❌"); return; }

  const btn = $("import-confirm-btn");
  if (btn) btn.disabled = true;

  const BATCH_LIMIT = 200;
  let processed = 0, created = 0, updated = 0;

  try {
    for (let i = 0; i < valid.length; i += BATCH_LIMIT) {
      const chunk = valid.slice(i, i + BATCH_LIMIT);
      const batch = writeBatch(db);

      for (const row of chunk) {
        const data = {
          name: row.name,
          sku: row.sku,
          barcode: row.barcode,
          category: row.category,
          quantity: row.quantity,
          cost: row.cost,
          price: row.price,
          discount: row.discount || 0,
          discountType: "percent",
          discountPrice: row.discountPrice || 0,
          expiry: row.expiry,
          threshold: row.threshold,
          workspaceId: wsId,
          updatedAt: serverTimestamp()
        };

        if (row._action === "update" && row._existingId) {
          batch.update(doc(db, "inventory", row._existingId), data);
          updated++;
        } else {
          const newRef = doc(collection(db, "inventory"));
          batch.set(newRef, { ...data, createdAt: serverTimestamp() });
          created++;
        }
      }

      await settleWrite(batch.commit(), "Import chunk");
      processed += chunk.length;
      showToast(`Imported ${processed}/${valid.length}…`);
    }

    playSuccessSound();
    showToast(`Import complete · ${created} new, ${updated} updated ✅`);
    closeImportModal();
  } catch (err) {
    console.error("[import] commit failed:", err);
    showToast(`Import failed: ${err.code || err.message} ❌`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function downloadImportTemplate() {
  const sample = [
    { Name: "White bread",     SKU: "1001", Barcode: "", Category: "bread",           Quantity: 95,  Cost: 15, Price: 25, "Discount%": 40, "Discount price": 15,  Expiry: "",           Threshold: 10 },
    { Name: "Petroleum Jelly", SKU: "1002", Barcode: "", Category: "Petroleum Jelly", Quantity: 148, Cost: 12, Price: 16, "Discount%": 50, "Discount price": 8,   Expiry: "",           Threshold: 20 },
    { Name: "Rexona",          SKU: "1003", Barcode: "", Category: "deodorant",       Quantity: 195, Cost: 18, Price: 24, "Discount%": 65, "Discount price": 8.4, Expiry: "",           Threshold: 15 },
    { Name: "Coke 1.5L",       SKU: "1004", Barcode: "4801234567890", Category: "Drinks", Quantity: 50, Cost: 55, Price: 75, "Discount%": 0, "Discount price": 0,  Expiry: "2026-12-31", Threshold: 10 }
  ];
  const ws = XLSX.utils.json_to_sheet(sample, { header: IMPORT_COLUMNS });
  const colWidths = IMPORT_COLUMNS.map(h => ({ wch: Math.max(h.length + 2, 12) }));
  ws["!cols"] = colWidths;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Inventory");
  downloadXLSX(wb, `import_template_${new Date().toISOString().slice(0,10)}.xlsx`);
  showToast("Template downloaded 📋");
}

function wireImport() {
  $("import-inv-excel-btn")?.addEventListener("click", openImportModal);
  $("import-close")?.addEventListener("click", closeImportModal);
  $("import-modal")?.addEventListener("click", (e) => {
    if (e.target === $("import-modal")) closeImportModal();
  });
  $("import-pick-btn")?.addEventListener("click", () => $("import-file-input")?.click());
  $("import-file-input")?.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) handleImportFile(f);
  });
  $("import-confirm-btn")?.addEventListener("click", commitImport);
  $("import-download-template")?.addEventListener("click", downloadImportTemplate);
}

/* =========================================================
   OPTIONAL HELPER — clear ALL discounts in the workspace
   ---------------------------------------------------------
   Run once from the browser console after this fix ships:
       window.clearAllDiscounts()
   Wipes `discount` and `discountPrice` to 0 on every item so
   any stale values left behind by the old importer are gone.
   ========================================================= */
export async function clearAllDiscounts() {
  const wsId = myWorkspace();
  if (!wsId) { showToast("Workspace not ready ❌"); return; }
  if (!confirm("Clear ALL discounts from every item in this workspace?")) return;

  const BATCH_LIMIT = 200;
  const items = state.inventory.slice();
  if (!items.length) { showToast("No items to update"); return; }

  let done = 0;
  try {
    for (let i = 0; i < items.length; i += BATCH_LIMIT) {
      const chunk = items.slice(i, i + BATCH_LIMIT);
      const batch = writeBatch(db);
      chunk.forEach(item => {
        batch.update(doc(db, "inventory", item.id), {
          discount: 0,
          discountPrice: 0,
          updatedAt: serverTimestamp()
        });
      });
      await settleWrite(batch.commit(), "Clear discounts");
      done += chunk.length;
      showToast(`Cleared ${done}/${items.length}…`);
    }
    playSuccessSound();
    showToast(`Cleared discounts on ${items.length} items ✅`);
  } catch (err) {
    showToast(`Failed: ${err.code || err.message} ❌`);
  }
}
window.clearAllDiscounts = clearAllDiscounts;

/* =========================================================
   LISTENERS
   ========================================================= */
export function startInventoryListeners(onAfterInventoryChange) {
  const wsId = myWorkspace(); if (!wsId) return;

  state.unsubscribers.inventory = onSnapshot(
    query(collection(db, "inventory"), where("workspaceId", "==", wsId)),
    (snap) => {
      state.inventory = snap.docs
        .map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      safeRender(renderInventory);
      safeRender(renderLowStockAlerts);
      safeRender(renderExpiring);
      safeRender(renderDashboardInventory);
      safeRender(autoFillSku);
      safeRender(renderInventoryAnalytics); // 👈 ADD THIS LINE
      onAfterInventoryChange?.();
    },
    (err) => { console.error("[Inventory listener]", err.code, err.message); showToast("Inventory sync failed ❌"); }
  );

  state.unsubscribers.categories = onSnapshot(
    query(collection(db, "categories"), where("workspaceId", "==", wsId)),
    (snap) => {
      state.categories = snap.docs
        .map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      safeRender(renderCategories);
      onAfterInventoryChange?.();
    },
    (err) => console.error("[Categories listener]", err.code, err.message)
  );

  state.unsubscribers.movements = onSnapshot(
    query(collection(db, "movements"), where("workspaceId", "==", wsId)),
    (snap) => {
      state.movements = snap.docs
        .map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
        .sort((a, b) => {
          const ta = a.createdAt?.toMillis?.() ?? 0;
          const tb = b.createdAt?.toMillis?.() ?? 0;
          return tb - ta;
        })
        .slice(0, 200);
      safeRender(renderMovements);
    },
    (err) => console.error("[Movements listener]", err.code, err.message)
  );
}

/* =========================================================
   AUTO-SYNC — File System Access API (per-workspace)
   ========================================================= */

const AUTOSYNC_DB     = "kurt-autosync";
const AUTOSYNC_STORE  = "handles";
const AUTOSYNC_LEGACY = "inventory-file";   // old global key — auto-migrated

/* ---------- Per-workspace key (one linked file per login) ---------- */
function autosyncKey() {
  const ws = myWorkspace() || "default";
  return `inventory-file:${ws}`;
}

/* ---------- In-memory handle cache ---------- */
let _cachedHandle = undefined;   // undefined = not loaded yet, null = none stored
let _cachedKey    = null;

/* ---------- IndexedDB helpers ---------- */
function _openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AUTOSYNC_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AUTOSYNC_STORE)) {
        db.createObjectStore(AUTOSYNC_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
async function _idbPut(key, val) {
  const idb = await _openIDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(AUTOSYNC_STORE, "readwrite");
    tx.objectStore(AUTOSYNC_STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}
async function _idbGet(key) {
  const idb = await _openIDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(AUTOSYNC_STORE, "readonly");
    const req = tx.objectStore(AUTOSYNC_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}
async function _idbDel(key) {
  const idb = await _openIDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(AUTOSYNC_STORE, "readwrite");
    tx.objectStore(AUTOSYNC_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

/* ---------- Support check ---------- */
function supportsFileSystemAccess() {
  return typeof window !== "undefined" && "showOpenFilePicker" in window;
}

/* ---------- Handle storage (with legacy migration) ---------- */
async function getStoredHandle() {
  const key = autosyncKey();
  if (_cachedKey === key && _cachedHandle !== undefined) return _cachedHandle;

  let handle = null;
  try { handle = await _idbGet(key); } catch (e) {
    console.warn("[autosync] idb read failed:", e);
  }

  /* One-time migration from the old global key */
  if (!handle) {
    try {
      const legacy = await _idbGet(AUTOSYNC_LEGACY);
      if (legacy) {
        await _idbPut(key, legacy);
        await _idbDel(AUTOSYNC_LEGACY);
        handle = legacy;
        console.log("[autosync] migrated legacy handle →", key);
      }
    } catch (e) { console.warn("[autosync] migration failed:", e); }
  }

  _cachedHandle = handle;
  _cachedKey    = key;
  return handle;
}

async function setStoredHandle(handle) {
  const key = autosyncKey();
  _cachedHandle = handle;
  _cachedKey    = key;
  if (handle) await _idbPut(key, handle);
  else        await _idbDel(key);
}

/* ---------- Silent permission check (never prompts) ---------- */
async function hasReadPermission(handle) {
  if (!handle) return false;
  try {
    const p = await handle.queryPermission({ mode: "read" });
    return p === "granted";
  } catch (e) {
    console.warn("[autosync] queryPermission:", e);
    return false;
  }
}

/* ---------- UI refresh ---------- */
export async function updateAutoSyncUI() {
  const statusEl  = $("autosync-status");
  const linkBtn   = $("autosync-link-btn");
  const unlinkBtn = $("autosync-unlink-btn");
  const syncBtn   = $("autosync-sync-btn");
  if (!statusEl) return;

  if (!supportsFileSystemAccess()) {
    statusEl.innerHTML = "⚠️ Auto-sync needs <b>Chrome</b> or <b>Edge</b> on desktop. Use manual import below.";
    if (linkBtn)   linkBtn.disabled = true;
    if (unlinkBtn) unlinkBtn.classList.add("hidden");
    if (syncBtn)   syncBtn.classList.add("hidden");
    return;
  }
  if (linkBtn) linkBtn.disabled = false;

  const handle = await getStoredHandle();

  if (!handle) {
    statusEl.innerHTML = `No file linked yet. Click <b>🔗 Link File</b> to enable auto-sync.`;
    if (unlinkBtn) unlinkBtn.classList.add("hidden");
    if (syncBtn)   syncBtn.classList.add("hidden");
    if (linkBtn) {
      linkBtn.textContent  = "🔗 Link File";
      linkBtn.dataset.mode = "link";
    }
    return;
  }

  const granted = await hasReadPermission(handle);

  statusEl.innerHTML = granted
    ? `<span class="autosync-pulse"></span><b>${esc(handle.name)}</b> — auto-sync ON`
    : `📁 <b>${esc(handle.name)}</b> — click <b>🔓 Re-grant Access</b> to enable auto-sync.`;

  if (unlinkBtn) unlinkBtn.classList.remove("hidden");
  if (syncBtn)   syncBtn.classList.remove("hidden");

  if (linkBtn) {
    if (granted) {
      linkBtn.textContent  = "🔗 Replace File";
      linkBtn.dataset.mode = "replace";
    } else {
      linkBtn.textContent  = "🔓 Re-grant Access";
      linkBtn.dataset.mode = "regrant";
    }
  }
}

/* ---------- Regrant permission ----------
   MUST be called directly from a click handler.
   Do NOT add awaits before requestPermission().
   -------------------------------------------- */
async function regrantPermission() {
  const handle = await getStoredHandle();
  if (!handle) {
    showToast("No file linked ❌");
    await updateAutoSyncUI();
    return;
  }

  let granted = false;
  try {
    // Called as early as possible — the click's user gesture is still alive
    const perm = await handle.requestPermission({ mode: "read" });
    granted = perm === "granted";
  } catch (err) {
    console.error("[autosync] requestPermission failed:", err);
  }

  if (!granted) {
    showToast("Access not granted ⚠️");
    await updateAutoSyncUI();
    return;
  }

  playSuccessSound();
  showToast("Access granted ✅");
  await updateAutoSyncUI();

  /* Immediately do a silent sync so the user sees it working */
  await autoSyncFromFile({ silent: true });
}

/* ---------- Link a new file ---------- */
export async function linkAutoSyncFile() {
  if (!supportsFileSystemAccess()) {
    showToast("Auto-sync needs Chrome / Edge desktop ⚠️");
    return;
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{
        description: "Excel or CSV",
        accept: {
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
          "application/vnd.ms-excel": [".xls"],
          "text/csv": [".csv"]
        }
      }],
      multiple: false,
      excludeAcceptAllOption: false
    });
    if (!handle) return;

    /* Explicit read grant — should succeed since the picker just ran */
    try {
      const perm = await handle.requestPermission({ mode: "read" });
      if (perm !== "granted") { showToast("Access denied ❌"); return; }
    } catch (err) {
      console.warn("[autosync] requestPermission after picker:", err);
    }

    await setStoredHandle(handle);
    playSuccessSound();
    showToast(`Linked: ${handle.name} ✅`);
    await updateAutoSyncUI();

    /* First sync so the user sees it work */
    await autoSyncFromFile({ silent: false });
  } catch (err) {
    if (err && err.name === "AbortError") return;   // user cancelled picker
    console.error("[autosync] link failed:", err);
    showToast(`Link failed: ${err.message} ❌`);
  }
}

/* ---------- Unlink ---------- */
export async function unlinkAutoSyncFile() {
  if (!confirm("Unlink the file? Auto-sync will stop.")) return;
  try {
    await setStoredHandle(null);
    showToast("File unlinked 🗑️");
    await updateAutoSyncUI();
  } catch (err) { showToast(`Failed: ${err.message} ❌`); }
}

/* ---------- Row compare ---------- */
function rowMatchesInventory(current, row) {
  if (!current) return false;
  return (
    (current.name || "")           === (row.name || "") &&
    (current.category || "")       === (row.category || "") &&
    (current.barcode || "")        === (row.barcode || "") &&
    Number(current.price || 0)     === Number(row.price || 0) &&
    Number(current.cost || 0)      === Number(row.cost || 0) &&
    // 👇 QUANTITY IS IGNORED HERE so it never triggers an update
    // Number(current.quantity || 0)  === (row.quantity || 0) && 
    Number(current.discountPrice || 0) === Number(row.discountPrice || 0) &&
    Number(current.discount || 0)  === Number(row.discount || 0) &&
    (current.expiry || "")         === (row.expiry || "") &&
    Number(current.threshold ?? 5) === Number(row.threshold ?? 5)
  );
}

/* ---------- Core sync ----------
   NEVER prompts for permission.
   Call regrantPermission() from a click handler instead.
   -------------------------------- */
export async function autoSyncFromFile({ silent = false } = {}) {
  if (!state.currentUser) return;
  if (!supportsFileSystemAccess()) {
    if (!silent) showToast("Auto-sync not supported on this browser ⚠️");
    return;
  }

  const handle = await getStoredHandle();
  if (!handle) {
    if (!silent) showToast("No file linked. Click '🔗 Link File' first ⚠️");
    return;
  }

  const granted = await hasReadPermission(handle);
  if (!granted) {
    /* No silent prompts — the user must click Re-grant */
    if (!silent) showToast("Access needed — click '🔓 Re-grant Access' ⚠️");
    await updateAutoSyncUI();
    return;
  }

  /* Read & parse */
  let raw;
  try {
    const file = await handle.getFile();
    raw = await parseExcelFile(file);
  } catch (e) {
    console.warn("[autosync] read/parse failed:", e);
    if (!silent) showToast(`Read failed: ${e.message} ❌`);
    return;
  }
  if (!raw.length) { if (!silent) showToast("Linked file is empty ❌"); return; }

  const normalized = raw.map(normalizeImportRow);
  const planned    = planImport(normalized);
  const valid      = planned.filter(p => !p._errors.length);
  if (!valid.length) { if (!silent) showToast("No valid rows to sync ❌"); return; }

  /* Only changed rows */
  const changed = [];
  for (const row of valid) {
    const current = row._existingId ? state.inventory.find(i => i.id === row._existingId) : null;
    if (!current || !rowMatchesInventory(current, row)) changed.push(row);
  }

  if (!changed.length) {
    if (!silent) showToast("Already up to date ✅");
    return;
  }

  const wsId = myWorkspace();
  if (!wsId) { if (!silent) showToast("Workspace not ready ❌"); return; }

    const BATCH_LIMIT = 200;
  let updated = 0, created = 0;
  try {
    for (let i = 0; i < changed.length; i += BATCH_LIMIT) {
      const chunk = changed.slice(i, i + BATCH_LIMIT);
      const batch = writeBatch(db);
      
      for (const row of chunk) {
        // Find the live item in the app to get its current quantity
        const currentItem = row._existingId ? state.inventory.find(i => i.id === row._existingId) : null;

        // Handle discount logic: If Excel has 0 or blank, reset the discount
        const finalDiscount = row.discount > 0 ? row.discount : 0;
        const finalDiscountPrice = row.discount > 0 ? (row.discountPrice || 0) : 0;

        const data = {
          name: row.name,
          sku: row.sku,
          barcode: row.barcode,
          category: row.category,
          // 👇 PRESERVE APP QUANTITY: If item exists, keep the app's live quantity.
          quantity: currentItem ? currentItem.quantity : row.quantity, 
          cost: row.cost,
          price: row.price,
          discount: finalDiscount,
          discountType: "percent",
          discountPrice: finalDiscountPrice,
          expiry: row.expiry,
          threshold: row.threshold,
          workspaceId: wsId,
          updatedAt: serverTimestamp()
        };
        
        if (row._action === "update" && row._existingId) {
          batch.update(doc(db, "inventory", row._existingId), data);
          updated++;
        } else {
          batch.set(doc(collection(db, "inventory")), { ...data, createdAt: serverTimestamp() });
          created++;
        }
      }
      await settleWrite(batch.commit(), "AutoSync");
    }
    playSuccessSound();
    showToast(`Auto-synced · ${created} new, ${updated} updated ✅`);
  } catch (err) {
    console.error("[autosync] commit failed:", err);
    if (!silent) showToast(`Sync failed: ${err.code || err.message} ❌`);
  }
}

/* ---------- Periodic ticker (permission-aware, never toasts) ---------- */
let _autosyncInterval = null;
export function startAutoSyncTicker() {
  stopAutoSyncTicker();
  _autosyncInterval = setInterval(async () => {
    const handle = await getStoredHandle();
    if (!handle) return;
    if (!(await hasReadPermission(handle))) return;
    autoSyncFromFile({ silent: true });
  }, 60 * 1000);
}
export function stopAutoSyncTicker() {
  if (_autosyncInterval) { clearInterval(_autosyncInterval); _autosyncInterval = null; }
}

/* ---------- Wire the panel ---------- */
export function wireAutoSync() {
  /* One button, three modes: link / replace / regrant */
  $("autosync-link-btn")?.addEventListener("click", async (e) => {
    const mode = e.currentTarget.dataset.mode || "link";
    if (mode === "regrant") {
      await regrantPermission();
    } else {
      await linkAutoSyncFile();
    }
  });

  $("autosync-sync-btn")?.addEventListener("click", () => {
    autoSyncFromFile({ silent: false });
  });

  $("autosync-unlink-btn")?.addEventListener("click", unlinkAutoSyncFile);

  updateAutoSyncUI();
}