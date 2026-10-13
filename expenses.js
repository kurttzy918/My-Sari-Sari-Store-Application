/* expenses.js — Business expenses & budget tracker (with custom categories) */
import {
  collection, onSnapshot, addDoc, deleteDoc, doc, updateDoc,
  serverTimestamp, query, where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { state } from "./state.js";
import {
  $, valOf, esc, debounce, safeRender, showToast,
  myWorkspace, playSuccessSound, playErrorSound,
  fmtInt, fmtMoney, downloadXLSX, downloadPDF, printHTML,
  getStoreDisplayName
} from "./utils.js";

/* =========================================================
   DEFAULT CATEGORIES — always available, cannot be deleted
   ========================================================= */
const DEFAULT_CATEGORIES = [
  { id: "stock",       label: "Stock / Inventory",    emoji: "📦", color: "#3B82F6", custom: false },
  { id: "load-wallet", label: "Load Wallet Top-Up",   emoji: "📱", color: "#8B5CF6", custom: false },
  { id: "ewallet",     label: "GCash / Maya Wallet",  emoji: "💳", color: "#0B6FDE", custom: false },
  { id: "rent",        label: "Rent",                 emoji: "🏠", color: "#EF4444", custom: false },
  { id: "utilities",   label: "Utilities",            emoji: "💡", color: "#F59E0B", custom: false },
  { id: "salary",      label: "Salary / Wages",       emoji: "👥", color: "#10B981", custom: false },
  { id: "transport",   label: "Transportation",       emoji: "🚌", color: "#06B6D4", custom: false },
  { id: "supplies",    label: "Supplies",             emoji: "📎", color: "#A855F7", custom: false },
  { id: "repair",      label: "Repair & Maintenance", emoji: "🔧", color: "#EA580C", custom: false },
  { id: "taxes",       label: "Taxes & Fees",         emoji: "📋", color: "#6366F1", custom: false },
  { id: "food",        label: "Food / Meals",         emoji: "🍽️", color: "#F97316", custom: false },
  { id: "other",       label: "Others",               emoji: "💠", color: "#64748B", custom: false }
];

/* Picker for new custom categories */
const CUSTOM_EMOJI_PRESETS = ["🏷️","💼","🎁","🚚","🧾","🛒","💊","🎂","📢","🎓","🛠️","⛽","🔑","📦","🌐","🐾","👕","✈️","☕","💧"];
const CUSTOM_COLOR_PRESETS = ["#3B82F6","#8B5CF6","#EF4444","#F59E0B","#10B981","#06B6D4","#A855F7","#EA580C","#F97316","#64748B","#EC4899","#14B8A6"];

/* =========================================================
   STORAGE KEYS
   ========================================================= */
const BUDGET_KEY     = (ws) => `expensesBudget:${ws}`;
const CATEGORIES_KEY = (ws) => `expensesCustomCategories:${ws}`;

/* =========================================================
   CATEGORY MANAGEMENT
   ========================================================= */
function loadCustomCategories() {
  const ws = myWorkspace();
  if (!ws) return [];
  try {
    const raw = localStorage.getItem(CATEGORIES_KEY(ws));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(c => c && c.id && c.label)
      .map(c => ({
        id: String(c.id),
        label: String(c.label),
        emoji: String(c.emoji || "🏷️"),
        color: String(c.color || "#64748B"),
        custom: true
      }));
  } catch { return []; }
}

function saveCustomCategories(list) {
  const ws = myWorkspace(); if (!ws) return;
  try { localStorage.setItem(CATEGORIES_KEY(ws), JSON.stringify(list)); } catch {}
}

function getAllCategories() {
  return [...DEFAULT_CATEGORIES, ...loadCustomCategories()];
}

function findCategory(id) {
  return getAllCategories().find(c => c.id === id) || {
    id, label: id || "Uncategorized", emoji: "💠", color: "#64748B", custom: false
  };
}

/* Generate a unique slug-like ID from a label */
function makeCategoryId(label) {
  const slug = String(label)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  const all = getAllCategories().map(c => c.id);
  let id = slug || "custom";
  let n = 2;
  while (all.includes(id)) { id = `${slug}-${n++}`; }
  return id;
}

/* =========================================================
   MONTHLY BUDGET
   ========================================================= */
function loadBudget() {
  const ws = myWorkspace();
  if (!ws) return 0;
  try { return Number(localStorage.getItem(BUDGET_KEY(ws))) || 0; } catch { return 0; }
}
function saveBudget(amount) {
  const ws = myWorkspace(); if (!ws) return;
  try { localStorage.setItem(BUDGET_KEY(ws), String(Number(amount) || 0)); } catch {}
}

/* =========================================================
   DATE HELPERS
   ========================================================= */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function getTodayBounds() {
  const t = new Date(); t.setHours(0,0,0,0);
  return { start: t.getTime(), end: t.getTime() + 86400000 };
}
function getMonthStart() {
  const d = new Date(); d.setDate(1); d.setHours(0,0,0,0);
  return d.getTime();
}
function getYearStart() {
  const d = new Date(); d.setMonth(0, 1); d.setHours(0,0,0,0);
  return d.getTime();
}
function prettyDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch { return iso; }
}

/* =========================================================
   RENDER — Category Options (Add form select)
   ========================================================= */
function renderCategoryOptions(preserveValue) {
  const sel = $("expense-category");
  if (!sel) return;
  const cur = preserveValue ?? sel.value;
  const cats = getAllCategories();
  sel.innerHTML = cats.map(c =>
    `<option value="${esc(c.id)}">${c.emoji} ${esc(c.label)}${c.custom ? " ✦" : ""}</option>`
  ).join("");
  if (cur && cats.some(c => c.id === cur)) sel.value = cur;
}

/* =========================================================
   RENDER — Manage Categories Panel
   ========================================================= */
function renderManageCategories() {
  const container = $("expense-categories-list");
  if (!container) return;

  const cats = getAllCategories();

  container.innerHTML = cats.map(c => `
    <div class="exp-cat-manage-row ${c.custom ? "is-custom" : ""}" data-cat-id="${esc(c.id)}">
      <div class="exp-cat-manage-icon" style="background:${c.color}">
        ${c.emoji}
      </div>
      <div class="exp-cat-manage-info">
        <div class="exp-cat-manage-name">${esc(c.label)}</div>
        <div class="exp-cat-manage-badge">
          ${c.custom ? "Custom" : "Default"}
        </div>
      </div>
      ${c.custom ? `
        <button type="button" class="sale-action-btn" data-act="edit" data-id="${esc(c.id)}" title="Edit">✏️</button>
        <button type="button" class="sale-action-btn delete" data-act="delete" data-id="${esc(c.id)}" title="Delete">🗑️</button>
      ` : `<span class="exp-cat-manage-lock" title="Built-in category">🔒</span>`}
    </div>
  `).join("");

  container.querySelectorAll('[data-act="edit"]').forEach(btn => {
    btn.addEventListener("click", () => editCustomCategory(btn.dataset.id));
  });
  container.querySelectorAll('[data-act="delete"]').forEach(btn => {
    btn.addEventListener("click", () => deleteCustomCategory(btn.dataset.id));
  });
}

/* =========================================================
   OPEN — Add Category Modal
   ========================================================= */
let _editingCategoryId = null;

function openCategoryEditor(categoryToEdit = null) {
  const modal = $("expense-cat-modal");
  if (!modal) return;

  _editingCategoryId = categoryToEdit?.id || null;

  const titleEl = $("expense-cat-modal-title");
  const nameEl  = $("expense-cat-name");
  const emojiEl = $("expense-cat-emoji");
  const colorEl = $("expense-cat-color");

  if (titleEl) titleEl.textContent = categoryToEdit
    ? "Edit Category"
    : "New Expense Category";

  if (nameEl)  nameEl.value  = categoryToEdit?.label || "";
  if (emojiEl) emojiEl.value = categoryToEdit?.emoji || "🏷️";
  if (colorEl) colorEl.value = categoryToEdit?.color || "#3B82F6";

  /* Build preset pickers */
  const emojiGrid = $("expense-cat-emoji-grid");
  if (emojiGrid) {
    emojiGrid.innerHTML = CUSTOM_EMOJI_PRESETS.map(e =>
      `<button type="button" class="exp-preset-btn ${e === (categoryToEdit?.emoji || "🏷️") ? "is-active" : ""}" data-emoji="${e}">${e}</button>`
    ).join("");
    emojiGrid.querySelectorAll("[data-emoji]").forEach(b => {
      b.addEventListener("click", () => {
        const e = b.dataset.emoji;
        if (emojiEl) emojiEl.value = e;
        emojiGrid.querySelectorAll("[data-emoji]").forEach(x => x.classList.toggle("is-active", x === b));
      });
    });
  }

  const colorGrid = $("expense-cat-color-grid");
  if (colorGrid) {
    colorGrid.innerHTML = CUSTOM_COLOR_PRESETS.map(c =>
      `<button type="button" class="exp-color-swatch ${c === (categoryToEdit?.color || "#3B82F6") ? "is-active" : ""}" data-color="${c}" style="background:${c}"></button>`
    ).join("");
    colorGrid.querySelectorAll("[data-color]").forEach(b => {
      b.addEventListener("click", () => {
        const c = b.dataset.color;
        if (colorEl) colorEl.value = c;
        colorGrid.querySelectorAll("[data-color]").forEach(x => x.classList.toggle("is-active", x === b));
      });
    });
  }

  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  setTimeout(() => nameEl?.focus(), 100);
}

function closeCategoryEditor() {
  $("expense-cat-modal")?.classList.add("hidden");
  document.body.style.overflow = "";
  _editingCategoryId = null;
}

/* =========================================================
   SAVE / EDIT / DELETE custom category
   ========================================================= */
function saveCustomCategory() {
  const nameEl  = $("expense-cat-name");
  const emojiEl = $("expense-cat-emoji");
  const colorEl = $("expense-cat-color");

  const label = (nameEl?.value || "").trim();
  const emoji = (emojiEl?.value || "🏷️").trim() || "🏷️";
  const color = (colorEl?.value || "#3B82F6").trim() || "#3B82F6";

  if (!label) {
    playErrorSound();
    showToast("Enter a category name ❌");
    return;
  }

  const custom = loadCustomCategories();

  if (_editingCategoryId) {
    /* ---- Edit existing ---- */
    const idx = custom.findIndex(c => c.id === _editingCategoryId);
    if (idx === -1) { showToast("Category not found ❌"); return; }
    custom[idx] = { ...custom[idx], label, emoji, color };
    saveCustomCategories(custom);
    playSuccessSound();
    showToast(`Category "${label}" updated ✅`);
  } else {
    /* ---- Create new ---- */
    /* Reject duplicate label (case-insensitive) against defaults + customs */
    const all = getAllCategories();
    if (all.some(c => c.label.toLowerCase() === label.toLowerCase())) {
      playErrorSound();
      showToast(`"${label}" already exists ❌`);
      return;
    }
    const id = makeCategoryId(label);
    custom.push({ id, label, emoji, color });
    saveCustomCategories(custom);
    playSuccessSound();
    showToast(`Category "${label}" added ✅`);
  }

  closeCategoryEditor();
  renderCategoryOptions();
  renderManageCategories();
  // Re-render the filter dropdown so it picks up new categories
  renderExpensesList();
}

function editCustomCategory(id) {
  const cat = loadCustomCategories().find(c => c.id === id);
  if (!cat) return;
  openCategoryEditor(cat);
}

function deleteCustomCategory(id) {
  const cat = loadCustomCategories().find(c => c.id === id);
  if (!cat) return;

  /* Count how many expenses use this category */
  const used = (state.expenses || []).filter(e => e.category === id).length;
  const msg = used > 0
    ? `Delete "${cat.label}"?\n\n⚠️ ${used} expense${used !== 1 ? "s" : ""} use this category. They will still exist but show as "Uncategorized".`
    : `Delete "${cat.label}"?`;
  if (!confirm(msg)) return;

  const remaining = loadCustomCategories().filter(c => c.id !== id);
  saveCustomCategories(remaining);
  playSuccessSound();
  showToast(`Category "${cat.label}" deleted 🗑️`);

  renderCategoryOptions();
  renderManageCategories();
  renderExpensesList();
}

/* =========================================================
   RENDER — Summary
   ========================================================= */
function renderExpensesSummary() {
  const { start, end } = getTodayBounds();
  const monthStart = getMonthStart();
  const yearStart  = getYearStart();

  let today = 0, month = 0, year = 0, total = 0, countMonth = 0;

  state.expenses.forEach(e => {
    const ms = e.createdAt?.toMillis?.() ?? 0;
    const amt = Number(e.amount) || 0;
    total += amt;
    if (ms >= start && ms < end) today += amt;
    if (ms >= monthStart) { month += amt; countMonth++; }
    if (ms >= yearStart) year += amt;
  });

  const budget = loadBudget();
  const budgetLeft = budget > 0 ? Math.max(0, budget - month) : 0;
  const budgetPct = budget > 0 ? Math.min(100, (month / budget) * 100) : 0;

  const setTxt = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  setTxt("expenses-today",  fmtMoney(today));
  setTxt("expenses-month",  fmtMoney(month));
  setTxt("expenses-year",   fmtMoney(year));
  setTxt("expenses-total",  fmtMoney(total));
  setTxt("expenses-count",  `${fmtInt(countMonth)} entr${countMonth !== 1 ? "ies" : "y"} this month`);

  const budgetEl = $("expenses-budget-display");
  if (budgetEl) {
    if (budget <= 0) {
      budgetEl.innerHTML = `<span class="expenses-budget-empty">No monthly budget set</span>`;
    } else {
      const barClass = budgetPct >= 100 ? "over" : budgetPct >= 80 ? "warn" : "ok";
      budgetEl.innerHTML = `
        <div class="expenses-budget-row">
          <span>Monthly Budget</span>
          <strong>${fmtMoney(budget)}</strong>
        </div>
        <div class="expenses-budget-row">
          <span>Used</span>
          <strong class="expenses-used ${barClass}">${fmtMoney(month)} (${budgetPct.toFixed(0)}%)</strong>
        </div>
        <div class="expenses-budget-row">
          <span>Remaining</span>
          <strong class="${budgetLeft <= 0 ? "expenses-over" : "expenses-remaining"}">${fmtMoney(budgetLeft)}</strong>
        </div>
        <div class="expenses-budget-bar">
          <div class="expenses-budget-fill ${barClass}" style="width:${budgetPct}%"></div>
        </div>
      `;
    }
  }
}

/* =========================================================
   RENDER — Category Breakdown
   ========================================================= */
function renderCategoryBreakdown() {
  const container = $("expenses-category-breakdown");
  if (!container) return;

  const monthStart = getMonthStart();
  const map = {};
  let monthTotal = 0;

  state.expenses.forEach(e => {
    const ms = e.createdAt?.toMillis?.() ?? 0;
    if (ms < monthStart) return;
    const cat = e.category || "other";
    const amt = Number(e.amount) || 0;
    map[cat] = (map[cat] || 0) + amt;
    monthTotal += amt;
  });

  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);

  if (!entries.length) {
    container.innerHTML = `<div class="empty-state" style="padding:16px;"><p>No expenses this month yet.</p></div>`;
    return;
  }

  const maxVal = entries[0][1];
  container.innerHTML = entries.map(([catId, val]) => {
    const cat = findCategory(catId);
    const pct = (val / maxVal) * 100;
    const sharePct = monthTotal > 0 ? (val / monthTotal * 100).toFixed(1) : "0";
    return `
      <div class="expenses-cat-item">
        <div class="expenses-cat-head">
          <span class="expenses-cat-emoji">${cat.emoji}</span>
          <span class="expenses-cat-label">${esc(cat.label)}</span>
          <span class="expenses-cat-amount">${fmtMoney(val)}</span>
          <span class="expenses-cat-share">${sharePct}%</span>
        </div>
        <div class="expenses-cat-bar">
          <div class="expenses-cat-fill" style="width:${pct}%;background:${cat.color}"></div>
        </div>
      </div>
    `;
  }).join("");
}

/* =========================================================
   FORM — Add / Save
   ========================================================= */
function resetExpenseForm() {
  const form = $("expense-form"); if (!form) return;
  form.reset();
  const idEl = $("expense-id"); if (idEl) idEl.value = "";
  if ($("expense-date")) $("expense-date").value = todayISO();
  if ($("expense-form-title")) $("expense-form-title").textContent = "Add Expense";
  $("expense-cancel-edit")?.classList.add("hidden");
  renderCategoryOptions();
}

function wireExpenseForm() {
  const form = $("expense-form"); if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const wsId = myWorkspace();
    if (!wsId) { showToast("Workspace not ready ❌"); return; }

    const idEl = $("expense-id");
    const wasEditing = !!(idEl && idEl.value);

    const amount = Number(valOf($("expense-amount")));
    const category = valOf($("expense-category")) || "other";
    const note = valOf($("expense-note")).trim();
    const date = valOf($("expense-date")) || todayISO();

    if (!amount || amount <= 0) {
      playErrorSound(); showToast("Amount must be greater than 0 ❌"); return;
    }

    const data = {
      workspaceId: wsId,
      amount,
      category,
      note,
      date,
      userId: state.currentUser?.uid || null
    };

    try {
      if (wasEditing) {
        await updateDoc(doc(db, "expenses", idEl.value), { ...data, updatedAt: serverTimestamp() });
        showToast("Expense updated ✅");
      } else {
        await addDoc(collection(db, "expenses"), { ...data, createdAt: serverTimestamp() });
        showToast("Expense recorded ✅");
        playSuccessSound();
      }
      resetExpenseForm();
    } catch (err) {
      showToast(`Failed: ${err.code || err.message} ❌`);
    }
  });

  $("expense-cancel-edit")?.addEventListener("click", resetExpenseForm);
}

/* =========================================================
   EDIT / DELETE
   ========================================================= */
export function editExpense(id) {
  const e = state.expenses.find(x => x.id === id);
  if (!e) return;
  const setVal = (elId, v) => { const el = $(elId); if (el) el.value = v; };
  setVal("expense-id", e.id);
  setVal("expense-amount", e.amount ?? "");
  renderCategoryOptions(e.category || "other");
  setVal("expense-note", e.note || "");
  setVal("expense-date", e.date || todayISO());
  if ($("expense-form-title")) $("expense-form-title").textContent = "Edit Expense";
  $("expense-cancel-edit")?.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
window.editExpense = editExpense;

export async function deleteExpense(id) {
  const e = state.expenses.find(x => x.id === id);
  if (!e) return;
  const cat = findCategory(e.category);
  if (!confirm(`Delete this expense?\n\n${cat.label} · ${fmtMoney(e.amount)}`)) return;
  try {
    await deleteDoc(doc(db, "expenses", id));
    playSuccessSound(); showToast("Expense deleted 🗑️");
  } catch (err) { showToast(`Failed: ${err.code || err.message} ❌`); }
}
window.deleteExpense = deleteExpense;

/* =========================================================
   LIST
   ========================================================= */
function getFilteredExpenses() {
  const term = valOf($("expense-search")).toLowerCase().trim();
  const catFilter = valOf($("expense-filter-category"));
  const range = valOf($("expense-filter-range"));
  let list = state.expenses.slice();

  if (catFilter) list = list.filter(e => e.category === catFilter);

  if (range) {
    const now = Date.now();
    const dayMs = 86400000;
    let cutoff = 0;
    if (range === "today") { const t = new Date(); t.setHours(0,0,0,0); cutoff = t.getTime(); }
    else if (range === "7") cutoff = now - 7 * dayMs;
    else if (range === "30") cutoff = now - 30 * dayMs;
    else if (range === "month") cutoff = getMonthStart();
    list = list.filter(e => (e.createdAt?.toMillis?.() ?? 0) >= cutoff);
  }

  if (term) {
    list = list.filter(e =>
      (e.note || "").toLowerCase().includes(term) ||
      findCategory(e.category).label.toLowerCase().includes(term)
    );
  }
  return list;
}

function renderExpensesList() {
  const list = $("expenses-list"); if (!list) return;

  /* Populate category filter dynamically */
  const filterSel = $("expense-filter-category");
  if (filterSel) {
    const cur = filterSel.value;
    const cats = getAllCategories();
    const sig = cats.map(c => c.id).join("|");
    if (filterSel.dataset.sig !== sig) {
      filterSel.dataset.sig = sig;
      filterSel.innerHTML = `<option value="">All Categories</option>` +
        cats.map(c => `<option value="${esc(c.id)}">${c.emoji} ${esc(c.label)}</option>`).join("");
      if (cur && cats.some(c => c.id === cur)) filterSel.value = cur;
    }
  }

  const filtered = getFilteredExpenses();

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><p>💸 No expenses recorded yet — add your first expense above.</p></div>`;
    return;
  }

  list.innerHTML = filtered.slice(0, 150).map(e => {
    const cat = findCategory(e.category);
    const date = e.date ? prettyDate(e.date) : (e.createdAt?.toDate?.().toLocaleDateString() || "—");
    return `
      <div class="expense-row">
        <div class="expense-row-icon" style="background:${cat.color}">${cat.emoji}</div>
        <div class="expense-row-main">
          <div class="expense-row-title">
            <strong>${esc(cat.label)}</strong>
            ${e.note ? `<span class="expense-row-note">· ${esc(e.note)}</span>` : ""}
          </div>
          <div class="expense-row-meta">${esc(date)}</div>
        </div>
        <div class="expense-row-amount">− ${fmtMoney(e.amount)}</div>
        <div class="expense-row-actions">
          <button type="button" class="sale-action-btn" onclick="editExpense('${e.id}')" title="Edit">✏️</button>
          <button type="button" class="sale-action-btn delete" onclick="deleteExpense('${e.id}')" title="Delete">🗑️</button>
        </div>
      </div>
    `;
  }).join("");
}

export function renderExpensesPage() {
  renderCategoryOptions();
  renderExpensesSummary();
  renderCategoryBreakdown();
  renderManageCategories();
  renderExpensesList();
}

/* =========================================================
   BUDGET
   ========================================================= */
function promptSetBudget() {
  const cur = loadBudget();
  const val = prompt(
    `Set your monthly budget.\n\nCurrent: ${fmtMoney(cur)}\n\nNew budget (₱, 0 to clear):`,
    cur > 0 ? String(cur) : "5000"
  );
  if (val === null) return;
  const n = Number(val);
  if (isNaN(n) || n < 0) { showToast("Invalid amount ❌"); return; }
  saveBudget(n);
  renderExpensesSummary();
  playSuccessSound();
  showToast(n > 0 ? `Budget set to ${fmtMoney(n)} ✅` : "Budget cleared ✅");
}

/* =========================================================
   EXPORTS
   ========================================================= */
export function exportExpensesExcel() {
  const list = getFilteredExpenses();
  if (!list.length) { showToast("No expenses to export ❌"); return; }
  const rows = list.map(e => {
    const cat = findCategory(e.category);
    return {
      Date: e.date || e.createdAt?.toDate?.().toLocaleDateString() || "",
      Category: cat.label,
      "Amount (₱)": Number((Number(e.amount) || 0).toFixed(2)),
      Note: e.note || ""
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Expenses");
  downloadXLSX(wb, `expenses_${new Date().toISOString().slice(0,10)}.xlsx`);
  showToast("Expenses exported ✅");
}

export function exportExpensesPDF() {
  const list = getFilteredExpenses();
  if (!list.length) { showToast("No expenses to export ❌"); return; }
  if (!window.jspdf) { showToast("PDF library not loaded ❌"); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(16); doc.text("Expense Report", 14, 18);
  doc.setFontSize(10); doc.text(`${getStoreDisplayName()} · ${new Date().toLocaleString()}`, 14, 24);
  doc.autoTable({
    startY: 30,
    head: [["Date", "Category", "Amount", "Note"]],
    body: list.map(e => {
      const cat = findCategory(e.category);
      return [
        e.date || e.createdAt?.toDate?.().toLocaleDateString() || "-",
        cat.label,
        fmtMoney(e.amount, false),
        (e.note || "").slice(0, 60)
      ];
    }),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [18, 84, 79] }
  });
  const total = list.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const y = doc.lastAutoTable.finalY + 10;
  doc.setFontSize(11);
  doc.text(`Total: ${fmtMoney(total)}`, 14, y);
  downloadPDF(doc, `expenses_${new Date().toISOString().slice(0,10)}.pdf`);
  showToast("Expenses PDF exported ✅");
}

/* =========================================================
   INIT + LISTENERS
   ========================================================= */
let _wired = false;

export function initExpenses() {
  renderCategoryOptions();
  renderManageCategories();

  if (!_wired) {
    _wired = true;
    wireExpenseForm();

    $("expense-set-budget")?.addEventListener("click", promptSetBudget);
    $("expense-search")?.addEventListener("input", debounce(renderExpensesList, 150));
    $("expense-filter-category")?.addEventListener("change", renderExpensesList);
    $("expense-filter-range")?.addEventListener("change", renderExpensesList);

    $("expenses-export-excel")?.addEventListener("click", exportExpensesExcel);
    $("expenses-export-pdf")?.addEventListener("click", exportExpensesPDF);

    /* ---------- Manage categories ---------- */
    $("expense-add-category-btn")?.addEventListener("click", () => openCategoryEditor(null));
    $("expense-cat-modal-close")?.addEventListener("click", closeCategoryEditor);
    $("expense-cat-cancel")?.addEventListener("click", closeCategoryEditor);
    $("expense-cat-save")?.addEventListener("click", saveCustomCategory);

    /* Close category modal on backdrop click / Escape */
    $("expense-cat-modal")?.addEventListener("click", (e) => {
      if (e.target === $("expense-cat-modal")) closeCategoryEditor();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("expense-cat-modal")?.classList.contains("hidden")) {
        closeCategoryEditor();
      }
    });

    /* Submit on Enter inside the category name field */
    $("expense-cat-name")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); saveCustomCategory(); }
    });
  }

  renderExpensesSummary();
  renderCategoryBreakdown();

  if ($("expense-date")) $("expense-date").value = todayISO();
}

export function startExpensesListeners(onAfter) {
  const wsId = myWorkspace();
  if (!wsId) return;
  state.unsubscribers.expenses = onSnapshot(
    query(collection(db, "expenses"), where("workspaceId", "==", wsId)),
    (snap) => {
      state.expenses = snap.docs
        .map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
        .sort((a, b) => {
          const ta = a.date ? new Date(a.date).getTime() : (a.createdAt?.toMillis?.() ?? 0);
          const tb = b.date ? new Date(b.date).getTime() : (b.createdAt?.toMillis?.() ?? 0);
          return tb - ta;
        });
      safeRender(renderExpensesPage);
      onAfter?.();
    },
    (err) => console.error("[Expenses listener]", err.code, err.message)
  );
}