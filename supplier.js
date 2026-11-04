/* supplier.js — Store-to-store supplier transfers (SAP-style line grid) */
import {
  collection, doc, getDoc, setDoc, updateDoc, writeBatch, serverTimestamp,
  onSnapshot, query, where, increment
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { state } from "./state.js";
import {
  $, valOf, esc, showToast, myWorkspace, movementDoc, settleWrite,
  fmtInt, playSuccessSound
} from "./utils.js";

const SHIP = "supplier_shipments";
const MAX_LINES = 100;
const LOOKUP_DEBOUNCE_MS = 500;
const PAGE_SIZE = 6;

let outgoing = [];
let incoming = [];
let draft = [];                 // [{ itemId, qty }]
let target = null;
let lookupTimer = null;
let lookupSeq = 0;
const restoring = new Set();

let incomingPage = 1;
let outgoingPage = 1;

/* =========================================================
   RECEIVER LOOKUP
   ========================================================= */
async function findStoreByEmail(email) {
  const clean = String(email || "").trim().toLowerCase();
  if (!clean || !clean.includes("@")) return null;
  const snap = await getDoc(doc(db, "supplier_directory", clean));
  if (!snap.exists()) return null;
  const d = snap.data();
  if (d.approved !== true || !d.workspaceId) return null;
  return { workspaceId: d.workspaceId, storeName: d.storeName || "Store", email: clean };
}

function setTargetStatus(html, cls = "") {
  const el = $("sup-target-status");
  if (!el) return;
  el.innerHTML = html;
  el.classList.remove("ok", "bad", "busy");
  if (cls) el.classList.add(cls);
}

function onTargetEmailInput() {
  const email = valOf($("sup-target-email")).trim().toLowerCase();
  clearTimeout(lookupTimer);
  target = null;

  if (!email) return setTargetStatus("");
  if (!email.includes("@")) return setTargetStatus("Enter a full email address.", "bad");
  if (email === (state.currentUser?.email || "").toLowerCase()) {
    return setTargetStatus("That's your own account.", "bad");
  }

  setTargetStatus("Looking up…", "busy");
  const seq = ++lookupSeq;

  lookupTimer = setTimeout(async () => {
    try {
      const found = await findStoreByEmail(email);
      if (seq !== lookupSeq) return;
      if (!found) { target = null; return setTargetStatus("✗ No approved store found.", "bad"); }
      if (found.workspaceId === myWorkspace()) {
        target = null; return setTargetStatus("That's your own store.", "bad");
      }
      target = found;
      setTargetStatus(`✓ Sending to: <strong>${esc(found.storeName)}</strong>`, "ok");
    } catch (err) {
      console.error("[supplier] lookup failed:", err);
      if (seq === lookupSeq) setTargetStatus("Lookup failed. Check connection.", "bad");
    }
  }, LOOKUP_DEBOUNCE_MS);
}

/* =========================================================
   INVENTORY HELPERS
   ========================================================= */
function stockOf(itemId) {
  return Number(state.inventory.find(i => i.id === itemId)?.quantity) || 0;
}

function findInventoryItem({ id, name, sku, barcode }) {
  if (id) {
    const hit = state.inventory.find(i => i.id === id);
    if (hit) return hit;
  }
  if (barcode) {
    const hit = state.inventory.find(i => (i.barcode || "").trim() === barcode.trim());
    if (hit) return hit;
  }
  if (sku) {
    const hit = state.inventory.find(i => (i.sku || "").toLowerCase() === sku.toLowerCase());
    if (hit) return hit;
  }
  if (name) {
    const n = name.toLowerCase();
    return state.inventory.find(i => (i.name || "").toLowerCase() === n) || null;
  }
  return null;
}

/* =========================================================
   DRAFT MUTATIONS
   ========================================================= */
function addLine(itemId, qty = 1) {
  if (!itemId) return false;
  if (draft.length >= MAX_LINES && !draft.some(d => d.itemId === itemId)) {
    showToast(`Max ${MAX_LINES} lines per shipment ❌`); return false;
  }
  const existing = draft.find(d => d.itemId === itemId);
  const total = (existing?.qty || 0) + qty;
  if (total > stockOf(itemId)) {
    showToast(`Only ${fmtInt(stockOf(itemId))} in stock ❌`); return false;
  }
  if (existing) existing.qty = total;
  else draft.push({ itemId, qty });
  renderDraft();
  return true;
}

function removeLine(itemId) {
  draft = draft.filter(d => d.itemId !== itemId);
  renderDraft();
}

function setLineQty(itemId, qty) {
  const n = Math.floor(Number(qty) || 0);
  if (n <= 0) return removeLine(itemId);
  if (n > stockOf(itemId)) {
    showToast(`Only ${fmtInt(stockOf(itemId))} in stock ❌`);
    return renderDraft();
  }
  const line = draft.find(d => d.itemId === itemId);
  if (line) line.qty = n;
  renderDraft();
}

function clearDraft() {
  if (!draft.length) return;
  if (!confirm("Clear all lines from this shipment?")) return;
  draft = [];
  renderDraft();
}

/* =========================================================
   BULK PASTE
   ========================================================= */
function bulkAddFromText(text) {
  const rows = String(text || "").split(/\r?\n/).map(r => r.trim()).filter(Boolean);
  if (!rows.length) return showToast("Nothing to add ❌");

  let added = 0;
  const failed = [];

  for (const row of rows) {
    const parts = row.split(/\t|\s*\|\s*|,\s*|\s{2,}/).map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) { failed.push({ row, reason: "need name + qty" }); continue; }

    const qty = Math.floor(Number(parts[parts.length - 1]) || 0);
    const key = parts.slice(0, -1).join(" ").trim();
    if (!qty || qty <= 0) { failed.push({ row, reason: "qty must be > 0" }); continue; }

    const item = findInventoryItem({ barcode: key, sku: key, name: key })
              || state.inventory.find(i => (i.name || "").toLowerCase().includes(key.toLowerCase()));

    if (!item) { failed.push({ row, reason: "not in inventory" }); continue; }

    const existing = draft.find(d => d.itemId === item.id);
    const newQty = (existing?.qty || 0) + qty;
    if (newQty > stockOf(item.id)) {
      failed.push({ row, reason: `only ${fmtInt(stockOf(item.id))} in stock` });
      continue;
    }
    if (existing) existing.qty = newQty;
    else {
      if (draft.length >= MAX_LINES) { failed.push({ row, reason: "max lines" }); continue; }
      draft.push({ itemId: item.id, qty });
    }
    added++;
  }

  renderDraft();
  if (added) showToast(`✅ Added ${added} line${added === 1 ? "" : "s"}`);
  if (failed.length) {
    console.warn("[supplier] bulk failures:", failed);
    showToast(`⚠️ ${failed.length} line${failed.length === 1 ? "" : "s"} skipped — see console`);
  }
}

/* =========================================================
   RENDER — Line grid
   ========================================================= */
function renderDraft() {
  const body = $("sup-draft-body");
  const empty = $("sup-draft-empty");
  const summary = $("sup-draft-summary");
  const sendBtn = document.querySelector('[data-sup-act="send"]');

  if (!body) return;

  if (!draft.length) {
    if (empty) empty.classList.remove("hidden");
    body.innerHTML = "";
    if (summary) summary.textContent = "0 items · 0 pcs";
    if (sendBtn) sendBtn.disabled = true;
    return;
  }

  if (empty) empty.classList.add("hidden");

  body.innerHTML = draft.map((d, i) => {
    const item = state.inventory.find(x => x.id === d.itemId);
    const stock = stockOf(d.itemId);
    return `
      <tr data-item-id="${esc(d.itemId)}">
        <td class="sup-td-num">${i + 1}</td>
        <td class="sup-td-name">
          <div class="sup-line-name">${esc(item?.name || "Item")}</div>
          <div class="sup-line-meta">
            ${item?.sku ? `<span>SKU: ${esc(item.sku)}</span>` : ""}
            ${item?.category ? `<span>· ${esc(item.category)}</span>` : ""}
          </div>
        </td>
        <td class="sup-td-qty">
          <div class="sup-qty-group">
            <button type="button" class="sup-qty-btn" data-sup-act="qty-dec" data-id="${esc(d.itemId)}">−</button>
            <input type="number" class="sup-qty-input" min="1" max="${stock}"
                   value="${d.qty}" data-sup-qty="${esc(d.itemId)}" />
            <button type="button" class="sup-qty-btn" data-sup-act="qty-inc" data-id="${esc(d.itemId)}">+</button>
          </div>
          <div class="sup-stock-note">/ ${fmtInt(stock)} in stock</div>
        </td>
        <td class="sup-td-del">
          <button type="button" class="sup-del-btn" data-sup-act="remove" data-id="${esc(d.itemId)}" title="Remove line">🗑️</button>
        </td>
      </tr>
    `;
  }).join("");

  const totalQty = draft.reduce((s, d) => s + d.qty, 0);
  if (summary) summary.textContent = `${draft.length} item${draft.length === 1 ? "" : "s"} · ${fmtInt(totalQty)} pcs`;
  if (sendBtn) sendBtn.disabled = false;
}

/* =========================================================
   SEND SHIPMENT
   ========================================================= */
async function sendShipment() {
  const wsId = myWorkspace();
  if (!wsId) return showToast("Workspace not ready ❌");
  if (!target) {
    const email = valOf($("sup-target-email")).trim();
    if (!email) return showToast("Enter the receiver's email ❌");
    return showToast("Wait for the receiver to be confirmed ❌");
  }
  if (!draft.length) return showToast("Add at least one item ❌");

  const fresh = await findStoreByEmail(target.email);
  if (!fresh) { target = null; return showToast("Receiver no longer available ❌"); }

  const lines = [];
  for (const d of draft) {
    const item = state.inventory.find(i => i.id === d.itemId);
    if (!item) return showToast("An item no longer exists ❌");
    if (d.qty > item.quantity) return showToast(`Not enough stock: ${item.name} ❌`);
    lines.push({
      itemId: item.id,
      name: item.name,
      sku: item.sku || "",
      barcode: item.barcode || "",
      category: item.category || "",
      price: Number(item.price) || 0,
      expiry: item.expiry || "",
      threshold: item.threshold ?? 5,
      quantity: d.qty
    });
  }

  const batch = writeBatch(db);
  batch.set(doc(collection(db, SHIP)), {
    fromWorkspaceId: wsId,
    fromUid: state.currentUser?.uid || null,
    fromEmail: (state.currentUser?.email || "").toLowerCase(),
    fromStoreName: state.currentWorkspace?.name || "Supplier",
    toWorkspaceId: fresh.workspaceId,
    toStoreName: fresh.storeName,
    toEmail: fresh.email,
    status: "pending",
    lines,
    itemCount: lines.length,
    totalQty: lines.reduce((s, l) => s + l.quantity, 0),
    stockReturned: false,
    createdAt: serverTimestamp()
  });

  lines.forEach(l => {
    batch.update(doc(db, "inventory", l.itemId), {
      quantity: increment(-l.quantity),
      updatedAt: serverTimestamp()
    });
    batch.set(doc(collection(db, "movements")), movementDoc({
      itemId: l.itemId, itemName: l.name, type: "out",
      quantity: l.quantity, reason: "adjustment",
      note: `Shipment to ${fresh.storeName}`
    }));
  });

  await settleWrite(batch.commit(), "Shipment");

  draft = [];
  target = null;
  $("sup-target-email").value = "";
  setTargetStatus("");
  renderDraft();
  playSuccessSound();
  showToast(`Shipment sent to ${fresh.storeName} ✅`);
}

/* =========================================================
   RECEIVE / RETURN
   ========================================================= */
function byCreatedDesc(a, b) {
  return (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0);
}

function findMatch(line) {
  const inv = state.inventory;
  if (line.barcode) {
    const hit = inv.find(i => (i.barcode || "").trim() === line.barcode);
    if (hit) return hit;
  }
  if (line.sku) {
    const hit = inv.find(i => (i.sku || "").toLowerCase() === line.sku.toLowerCase());
    if (hit) return hit;
  }
  return inv.find(i => (i.name || "").toLowerCase() === (line.name || "").toLowerCase()) || null;
}

async function acceptShipment(id) {
  const snap = await getDoc(doc(db, SHIP, id));
  if (!snap.exists() || snap.data().status !== "pending") {
    return showToast("This delivery was already handled ⚠️");
  }
  const s = { id, ...snap.data() };
  const wsId = myWorkspace();
  const batch = writeBatch(db);
  const usedSkus = new Set(state.inventory.map(i => String(i.sku || "").toLowerCase()));

  (s.lines || []).forEach(l => {
    const match = findMatch(l);
    if (match) {
      batch.update(doc(db, "inventory", match.id), {
        quantity: increment(l.quantity),
        updatedAt: serverTimestamp()
      });
      batch.set(doc(collection(db, "movements")), movementDoc({
        itemId: match.id, itemName: match.name, type: "in",
        quantity: l.quantity, reason: "restock", note: `From ${s.fromStoreName}`
      }));
    } else {
      const ref = doc(collection(db, "inventory"));
      let sku = l.sku || "";
      if (!sku || usedSkus.has(sku.toLowerCase())) sku = `SUP-${ref.id.slice(0, 6).toUpperCase()}`;
      usedSkus.add(sku.toLowerCase());

      batch.set(ref, {
        name: l.name, sku,
        barcode: l.barcode || "",
        category: l.category || "Uncategorized",
        quantity: l.quantity,
        cost: l.price || 0,
        price: l.price || 0,
        discount: 0, discountType: "percent", discountPrice: 0,
        expiry: l.expiry || "",
        threshold: l.threshold ?? 5,
        image: null,
        workspaceId: wsId,
        sourceShipmentId: id,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      batch.set(doc(collection(db, "movements")), movementDoc({
        itemId: ref.id, itemName: l.name, type: "in",
        quantity: l.quantity, reason: "restock", note: `From ${s.fromStoreName} (new)`
      }));
    }
  });

  batch.update(doc(db, SHIP, id), {
    status: "received",
    receivedAt: serverTimestamp(),
    receivedBy: state.currentUser?.uid || null
  });

  await settleWrite(batch.commit(), "Accept shipment");
  playSuccessSound();
  showToast(`Delivery from ${s.fromStoreName} added ✅`);
}

async function rejectShipment(id) {
  const snap = await getDoc(doc(db, SHIP, id));
  if (!snap.exists() || snap.data().status !== "pending") {
    return showToast("Already handled ⚠️");
  }
  if (!confirm("Reject this delivery? The supplier's stock will be returned.")) return;
  await updateDoc(doc(db, SHIP, id), {
    status: "rejected",
    rejectedAt: serverTimestamp(),
    rejectedBy: state.currentUser?.uid || null
  });
  showToast("Delivery rejected");
}

async function processRejectedReturns() {
  if (!state.inventory.length) return;
  for (const s of outgoing) {
    if (s.status !== "rejected" || s.stockReturned || restoring.has(s.id)) continue;
    restoring.add(s.id);
    try {
      const batch = writeBatch(db);
      (s.lines || []).forEach(l => {
        if (!state.inventory.some(i => i.id === l.itemId)) return;
        batch.update(doc(db, "inventory", l.itemId), {
          quantity: increment(l.quantity),
          updatedAt: serverTimestamp()
        });
        batch.set(doc(collection(db, "movements")), movementDoc({
          itemId: l.itemId, itemName: l.name, type: "in",
          quantity: l.quantity, reason: "adjustment",
          note: `Returned: ${s.toStoreName} rejected`
        }));
      });
      batch.update(doc(db, SHIP, s.id), { stockReturned: true });
      await settleWrite(batch.commit(), "Return stock");
    } catch (e) {
      console.error("[supplier] return failed:", e);
    } finally {
      restoring.delete(s.id);
    }
  }
}

/* =========================================================
   SHIPMENT CARD RENDERING & PAGINATION
   ========================================================= */
function badge(status) {
  const map = {
    pending:  ["Pending", "pending"],
    received: ["Received", "received"],
    rejected: ["Rejected", "rejected"]
  };
  const [label, cls] = map[status] || [status, ""];
  return `<span class="sup-badge ${cls}">${label}</span>`;
}

function shipmentCard(s, mode) {
  const date = s.createdAt?.toDate?.().toLocaleString() ?? "—";
  const party = mode === "in"
    ? `From: <strong>${esc(s.fromStoreName || "Supplier")}</strong>`
    : `To: <strong>${esc(s.toStoreName || s.toEmail || "Store")}</strong>`;
  const lines = (s.lines || []).map(l =>
    `<div class="sup-line"><span>${esc(l.name)}</span><span>×${fmtInt(l.quantity)}</span></div>`
  ).join("");
  const actions = mode === "in" && s.status === "pending"
    ? `<div class="sup-actions">
         <button type="button" class="btn primary sm" data-sup-act="accept" data-id="${esc(s.id)}">✅ Accept</button>
         <button type="button" class="btn danger sm" data-sup-act="reject" data-id="${esc(s.id)}">Reject</button>
       </div>`
    : "";
  return `
    <div class="card sup-card">
      <div class="sup-head"><span>${party}</span>${badge(s.status)}</div>
      <div class="sup-meta">${esc(date)} · ${fmtInt(s.totalQty || 0)} pcs · ${fmtInt(s.itemCount || 0)} item(s)</div>
      <div class="sup-lines">${lines}</div>
      ${actions}
    </div>`;
}

function renderPagination(containerId, totalPages, currentPage, type) {
  const container = $(containerId);
  if (!container) return;
  
  if (totalPages <= 1) {
    container.innerHTML = "";
    return;
  }

  let buttonsHtml = "";
  for (let i = 1; i <= totalPages; i++) {
    if (totalPages > 7 && i !== 1 && i !== totalPages && Math.abs(i - currentPage) > 1) {
      if (i === 2 || i === totalPages - 1) {
        buttonsHtml += `<span class="page-ellipsis">…</span>`;
      }
      continue;
    }
    buttonsHtml += `<button type="button" class="page-btn ${i === currentPage ? "active" : ""}" 
                     data-page-type="${type}" data-page-num="${i}">${i}</button>`;
  }

  const start = (currentPage - 1) * PAGE_SIZE + 1;
  const end = Math.min(currentPage * PAGE_SIZE, (currentPage * PAGE_SIZE) + PAGE_SIZE); // safe fallback

  container.innerHTML = `
    <div class="page-info">
      Page <strong>${currentPage}</strong> of <strong>${totalPages}</strong>
    </div>
    <div class="page-controls">
      <button type="button" class="page-btn" data-page-type="${type}" data-page-num="${currentPage - 1}" ${currentPage === 1 ? "disabled" : ""}>‹ Prev</button>
      ${buttonsHtml}
      <button type="button" class="page-btn" data-page-type="${type}" data-page-num="${currentPage + 1}" ${currentPage === totalPages ? "disabled" : ""}>Next ›</button>
    </div>
  `;
}

export function renderSupplierPage() {
  const page = $("page-supplier");
  if (!page) return;

  const ws = state.currentWorkspace;
  const emailEl = $("sup-owner-email");
  if (emailEl) emailEl.textContent = state.currentUser?.email || "";
  const storeEl = $("sup-store-name");
  if (storeEl) storeEl.textContent = ws?.name || "";

  renderDraft();

  // --- INCOMING SHIPMENTS ---
  const inc = [...incoming].sort(byCreatedDesc);
  const incTotalPages = Math.ceil(inc.length / PAGE_SIZE) || 1;
  if (incomingPage > incTotalPages) incomingPage = incTotalPages;
  const incStart = (incomingPage - 1) * PAGE_SIZE;
  const incPaginated = inc.slice(incStart, incStart + PAGE_SIZE);

  const incEl = $("sup-incoming");
  if (incEl) {
    incEl.innerHTML = incPaginated.length
      ? incPaginated.map(s => shipmentCard(s, "in")).join("")
      : `<div class="empty-state"><p>📭 No deliveries yet.</p></div>`;
    renderPagination("sup-incoming-pagination", incTotalPages, incomingPage, "in");
  }

  // --- OUTGOING SHIPMENTS ---
  const out = [...outgoing].sort(byCreatedDesc);
  const outTotalPages = Math.ceil(out.length / PAGE_SIZE) || 1;
  if (outgoingPage > outTotalPages) outgoingPage = outTotalPages;
  const outStart = (outgoingPage - 1) * PAGE_SIZE;
  const outPaginated = out.slice(outStart, outStart + PAGE_SIZE);

  const outEl = $("sup-outgoing");
  if (outEl) {
    outEl.innerHTML = outPaginated.length
      ? outPaginated.map(s => shipmentCard(s, "out")).join("")
      : `<div class="empty-state"><p>No shipments sent yet.</p></div>`;
    renderPagination("sup-outgoing-pagination", outTotalPages, outgoingPage, "out");
  }
}

/* =========================================================
   ITEM PICKER SEARCH
   ========================================================= */
let pickerSearch = "";
let pickerHighIndex = 0;

function renderPickerList() {
  const listEl = $("sup-picker-list");
  if (!listEl) return;

  const term = pickerSearch.trim().toLowerCase();
  let items = state.inventory.filter(i => (Number(i.quantity) || 0) > 0);
  if (term) {
    items = items.filter(i =>
      (i.name || "").toLowerCase().includes(term) ||
      (i.sku || "").toLowerCase().includes(term) ||
      (i.barcode || "").includes(term)
    );
  }
  items = items.slice(0, 40);

  if (!items.length) {
    listEl.innerHTML = `<div class="sup-picker-empty">No items match</div>`;
    return;
  }

  pickerHighIndex = Math.min(pickerHighIndex, items.length - 1);
  listEl.innerHTML = items.map((it, i) => `
    <button type="button" class="sup-picker-item ${i === pickerHighIndex ? "is-highlight" : ""}"
            data-pick-id="${esc(it.id)}">
      <span class="sup-picker-item-name">${esc(it.name)}</span>
      <span class="sup-picker-item-stock">${fmtInt(it.quantity)} in stock</span>
    </button>
  `).join("");
}

function pickItem(itemId) {
  if (addLine(itemId, 1)) {
    const input = $("sup-picker-search");
    if (input) { input.value = ""; pickerSearch = ""; renderPickerList(); input.focus(); }
  }
}

/* =========================================================
   EVENTS
   ========================================================= */
function wireSupplierPage() {
  const page = $("page-supplier");
  if (!page || page.dataset.wired) return;
  page.dataset.wired = "1";

  $("sup-target-email")?.addEventListener("input", onTargetEmailInput);

  // Picker search
  const searchInput = $("sup-picker-search");
  searchInput?.addEventListener("input", (e) => {
    pickerSearch = e.target.value;
    pickerHighIndex = 0;
    renderPickerList();
  });
  searchInput?.addEventListener("keydown", (e) => {
    const list = $("sup-picker-list");
    if (!list) return;
    const rows = list.querySelectorAll(".sup-picker-item");
    if (!rows.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      pickerHighIndex = (pickerHighIndex + 1) % rows.length;
      renderPickerList();
      list.querySelector(".is-highlight")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      pickerHighIndex = (pickerHighIndex - 1 + rows.length) % rows.length;
      renderPickerList();
      list.querySelector(".is-highlight")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const highlighted = list.querySelector(".is-highlight");
      if (highlighted) pickItem(highlighted.dataset.pickId);
    }
  });
  searchInput?.addEventListener("focus", renderPickerList);

  // Bulk paste
  $("sup-bulk-btn")?.addEventListener("click", () => {
    const ta = $("sup-bulk-text");
    if (!ta) return;
    bulkAddFromText(ta.value);
    ta.value = "";
  });

  // Clear draft
  $("sup-clear-btn")?.addEventListener("click", clearDraft);

  // Draft qty input — live + blur
  page.addEventListener("input", (e) => {
    const input = e.target.closest("[data-sup-qty]");
    if (!input) return;
    const itemId = input.dataset.supQty;
    const v = Number(input.value);
    const line = draft.find(d => d.itemId === itemId);
    if (line && Number.isFinite(v)) line.qty = Math.max(1, Math.floor(v));
    const summary = $("sup-draft-summary");
    if (summary) {
      const totalQty = draft.reduce((s, d) => s + d.qty, 0);
      summary.textContent = `${draft.length} item${draft.length === 1 ? "" : "s"} · ${fmtInt(totalQty)} pcs`;
    }
  });
  page.addEventListener("change", (e) => {
    const input = e.target.closest("[data-sup-qty]");
    if (!input) return;
    setLineQty(input.dataset.supQty, input.value);
  });

  // Delegated actions (Actions + Pagination)
  page.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-sup-act], [data-pick-id], [data-page-type]");
    if (!btn) return;

    // Pagination clicks
    if (btn.dataset.pageType) {
      const type = btn.dataset.pageType;
      const pageNum = Number(btn.dataset.pageNum);
      if (type === "in") incomingPage = pageNum;
      if (type === "out") outgoingPage = pageNum;
      renderSupplierPage();
      return;
    }

    // Picker clicks
    if (btn.dataset.pickId) { pickItem(btn.dataset.pickId); return; }

    // Draft & Shipment clicks
    const act = btn.dataset.supAct;
    const id = btn.dataset.id;
    try {
      if (act === "remove") removeLine(id);
      else if (act === "qty-inc") setLineQty(id, (draft.find(d => d.itemId === id)?.qty || 0) + 1);
      else if (act === "qty-dec") setLineQty(id, (draft.find(d => d.itemId === id)?.qty || 0) - 1);
      else if (act === "send") await sendShipment();
      else if (act === "accept") await acceptShipment(id);
      else if (act === "reject") await rejectShipment(id);
    } catch (err) {
      console.error("[supplier]", err);
      showToast(`Failed: ${err.code || err.message} ❌`);
    }
  });
}

/* =========================================================
   PUBLIC API
   ========================================================= */
export function initSupplier() {
  wireSupplierPage();
  renderPickerList();
}

export function startSupplierListeners() {
  const wsId = myWorkspace();
  if (!wsId) return;

  state.unsubscribers.supplierOut = onSnapshot(
    query(collection(db, SHIP), where("fromWorkspaceId", "==", wsId)),
    (snap) => {
      outgoing = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      processRejectedReturns();
      renderSupplierPage();
    },
    (err) => console.error("[Supplier outgoing]", err.code, err.message)
  );

  state.unsubscribers.supplierIn = onSnapshot(
    query(collection(db, SHIP), where("toWorkspaceId", "==", wsId)),
    (snap) => {
      incoming = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderSupplierPage();
    },
    (err) => console.error("[Supplier incoming]", err.code, err.message)
  );
}

export async function ensureDirectoryEntry() {
  const ws = state.currentWorkspace;
  const user = state.currentUser;
  const email = (user?.email || "").trim().toLowerCase();
  const wsId = myWorkspace();
  if (!email || !wsId) return;
  const storeName = ws?.name || state.currentUserData?.storeName || "Store";

  try {
    await setDoc(doc(db, "supplier_directory", email), {
      email, workspaceId: wsId, storeName, approved: true
    }, { merge: true });
    console.log("[directory] listed:", email);
  } catch (e) {
    console.error("[directory] write failed:", e.code || e.message);
  }
}