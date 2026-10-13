/* customers.js — Customer management + credit (utang) ledger */
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc,
  serverTimestamp, query, where, writeBatch, increment, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { state, CONSTANTS } from "./state.js";
import {
  $, valOf, numOf, setVal, esc, debounce, safeRender, showToast,
  myWorkspace, settleWrite, playSuccessSound, fmtInt, fmtMoney,
  customerTxDoc, printHTML
} from "./utils.js";

/* =========================================================
   PAYMENT-HISTORY BULK-SELECTION STATE (NEW)
   ========================================================= */
const selectedPayments = new Set();

/* =========================================================
   CRUD
   ========================================================= */
function wireCustomerForm() {
  const form = $("customer-form");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const wsId = myWorkspace();
    if (!wsId) { showToast("Workspace not ready ❌"); return; }
    const idEl = $("customer-id");
    const wasEditing = !!(idEl && idEl.value);

    const data = {
      name: valOf($("customer-name")).trim(),
      phone: valOf($("customer-phone")).trim(),
      address: valOf($("customer-address")).trim(),
      notes: valOf($("customer-notes")).trim(),
      workspaceId: wsId,
      updatedAt: serverTimestamp()
    };
    if (!data.name) { showToast("Name is required ❌"); return; }

    try {
      if (wasEditing) {
        await updateDoc(doc(db, "customers", idEl.value), data);
        showToast("Customer updated ✅");
      } else {
        await addDoc(collection(db, "customers"), {
          ...data,
          balance: 0,
          totalPurchases: 0,
          lastPurchaseAt: null,
          createdAt: serverTimestamp()
        });
        showToast("Customer added ✅");
      }
      form.reset();
      if (idEl) idEl.value = "";
      if ($("customer-form-title")) $("customer-form-title").textContent = "Add Customer";
    } catch (err) {
      showToast(`Failed: ${err.code || err.message} ❌`);
    }
  });
}

export function editCustomer(id) {
  const c = state.customers.find(x => x.id === id);
  if (!c) return;
  setVal($("customer-id"), c.id);
  setVal($("customer-name"), c.name || "");
  setVal($("customer-phone"), c.phone || "");
  setVal($("customer-address"), c.address || "");
  setVal($("customer-notes"), c.notes || "");
  if ($("customer-form-title")) $("customer-form-title").textContent = "Edit Customer";
  document.querySelector('[data-page="page-customers"]')?.click();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
window.editCustomer = editCustomer;

export async function deleteCustomer(id) {
  const c = state.customers.find(x => x.id === id);
  if (!c) return;
  if (Number(c.balance) > 0) {
    if (!confirm(`⚠️ ${c.name} still owes ${fmtMoney(c.balance)}.\n\nDelete anyway? Their ledger will be lost.`)) return;
  } else if (!confirm(`Delete customer "${c.name}"?`)) return;
  try {
    await deleteDoc(doc(db, "customers", id));
    playSuccessSound();
    showToast("Customer deleted 🗑️");
  } catch (err) { showToast(`Failed: ${err.code || err.message} ❌`); }
}
window.deleteCustomer = deleteCustomer;

/* =========================================================
   PAYMENT — with Cash-Basis Date Migration
   ========================================================= */
export function recordPayment(customerId) {
  const c = state.customers.find(x => x.id === customerId);
  if (!c) { showToast("Customer not found ❌"); return; }
  if (Number(c.balance) <= 0) { showToast("No outstanding balance ✅"); return; }
  state.currentCustomerId = customerId;
  const nameEl = $("payment-customer-name");
  const balEl  = $("payment-current-balance");
  const amtEl  = $("payment-amount");
  const noteEl = $("payment-note");
  if (nameEl) nameEl.textContent = c.name;
  if (balEl)  balEl.textContent = `Outstanding: ${fmtMoney(c.balance)}`;
  if (amtEl)  amtEl.value = Number(c.balance).toFixed(2);
  if (noteEl) noteEl.value = "";
  $("payment-modal")?.classList.remove("hidden");
  setTimeout(() => amtEl?.focus(), 100);
}
window.recordPayment = recordPayment;

function wirePaymentModal() {
  const confirmBtn = $("payment-confirm");
  if (!confirmBtn) return;

  confirmBtn.addEventListener("click", async () => {
    const id = state.currentCustomerId;
    if (!id) return;

    const c = state.customers.find(x => x.id === id);
    if (!c) return;

    const amount = Number(valOf($("payment-amount")));
    if (!amount || amount <= 0) {
      showToast("Enter a valid amount ❌");
      return;
    }
    if (amount > Number(c.balance) + 0.001) {
      showToast("Amount exceeds balance ❌");
      return;
    }

    confirmBtn.disabled = true;

    try {
      const batch = writeBatch(db);
      const nowTimestamp = Timestamp.fromDate(new Date());

      // 1) Reduce customer balance
      batch.update(doc(db, "customers", id), {
        balance: increment(-amount),
        updatedAt: nowTimestamp
      });

      // 2) Distribute payment across unpaid utang sales (oldest first)
      const MAX_IN_BATCH = 400;
      const unpaid = (state.creditSales || [])
        .filter(s => s.customerId === id)
        .sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0))
        .slice(0, MAX_IN_BATCH);

      let remaining = amount;
      let salesPaid = 0;
      const appliedTo = [];

      for (const sale of unpaid) {
        if (remaining <= 0.005) break;

        const saleTotal   = Number(sale.total) || 0;
        const alreadyPaid = Number(sale.amountPaid) || 0;
        const owed        = Math.max(0, saleTotal - alreadyPaid);
        if (owed <= 0.005) continue;

        const take          = Math.min(remaining, owed);
        const newPaidAmount = alreadyPaid + take;
        const fullyPaid     = newPaidAmount >= saleTotal - 0.01;

        appliedTo.push({
          saleId: sale.id,
          take,
          previousAmountPaid: alreadyPaid,
          previousUnpaidAmount: Math.max(0, saleTotal - alreadyPaid),
          previousCreatedAt: sale.createdAt || null,
          madeFullyPaid: fullyPaid
        });

        const updateData = {
          amountPaid: newPaidAmount,
          unpaidAmount: Math.max(0, saleTotal - newPaidAmount),
          paid: fullyPaid,
          paidAt: fullyPaid ? nowTimestamp : null
        };

        if (fullyPaid) {
          updateData.originalCreatedAt = sale.createdAt || null;
          updateData.createdAt = nowTimestamp;
        }

        batch.update(doc(db, "sales", sale.id), updateData);

        remaining -= take;
        if (fullyPaid) salesPaid++;
      }

      // 3) Log the payment in the ledger
      const txRef = doc(collection(db, "customer_transactions"));
      const paymentTx = {
        ...customerTxDoc({
          customerId: id,
          customerName: c.name,
          type: "payment",
          amount,
          note: valOf($("payment-note")).trim()
        }),
        appliedTo
      };
      paymentTx.createdAt = nowTimestamp;
      batch.set(txRef, paymentTx);

      await settleWrite(batch.commit(), "Payment");
      playSuccessSound();

      const tail = salesPaid
        ? ` · ${salesPaid} sale${salesPaid > 1 ? "s" : ""} marked paid ✅`
        : " · partial payment recorded";
      showToast(`Payment ${fmtMoney(amount)} received${tail}`);

      $("payment-modal")?.classList.add("hidden");
      state.currentCustomerId = null;
    } catch (err) {
      showToast(`Failed: ${err.code || err.message} ❌`);
    } finally {
      confirmBtn.disabled = false;
    }
  });
}

/* =========================================================
   PAYMENT HISTORY — Delete / Print / View
   ========================================================= */
export async function deletePayment(paymentId) {
  const p = state.customerTransactions.find(t => t.id === paymentId);
  if (!p || p.type !== "payment") { showToast("Payment not found ❌"); return; }

  const appliedCount = Array.isArray(p.appliedTo) ? p.appliedTo.length : 0;
  const warn = appliedCount
    ? `\n\n⚠️ This will revert ${appliedCount} sale${appliedCount !== 1 ? "s" : ""} back to unpaid and restore the customer's balance.`
    : `\n\n⚠️ This will restore the customer's balance.`;

  if (!confirm(`Delete this payment?\n\n${p.customerName} · ${fmtMoney(p.amount)}${warn}`)) return;

  try {
    await reversePaymentSilently(paymentId);
    playSuccessSound();
    showToast("Payment deleted & balance restored ✅");
  } catch (err) {
    showToast(`Failed: ${err.code || err.message} ❌`);
  }
}
window.deletePayment = deletePayment;

/* Silent reversal used by both single-delete and bulk-delete */
async function reversePaymentSilently(paymentId) {
  const p = state.customerTransactions.find(t => t.id === paymentId);
  if (!p || p.type !== "payment") throw new Error("Not a payment");

  const batch = writeBatch(db);
  const nowTimestamp = Timestamp.fromDate(new Date());

  // 1) Restore customer balance
  batch.update(doc(db, "customers", p.customerId), {
    balance: increment(Number(p.amount) || 0),
    updatedAt: nowTimestamp
  });

  // 2) Reverse affected sales
  if (Array.isArray(p.appliedTo)) {
    for (const a of p.appliedTo) {
      if (!a.saleId) continue;
      const saleUpdate = {
        amountPaid: Number(a.previousAmountPaid) || 0,
        unpaidAmount: Number(a.previousUnpaidAmount) || 0,
        paid: false,
        paidAt: null
      };
      if (a.previousCreatedAt) {
        saleUpdate.createdAt = a.previousCreatedAt;
      }
      batch.update(doc(db, "sales", a.saleId), saleUpdate);
    }
  }

  // 3) Delete the payment transaction
  batch.delete(doc(db, "customer_transactions", paymentId));

  await batch.commit();
}

export function printPayment(paymentId) {
  const p = state.customerTransactions.find(t => t.id === paymentId);
  if (!p || p.type !== "payment") { showToast("Payment not found ❌"); return; }

  const date = p.createdAt?.toDate?.().toLocaleString() || "—";
  const appliedCount = Array.isArray(p.appliedTo) ? p.appliedTo.length : 0;

  printHTML(`
    <h1>Payment Receipt</h1>
    <div class="meta">${esc(CONSTANTS.STORE_NAME)} · ${esc(date)}</div>
    <table>
      <tr><th style="width:180px">Customer</th><td>${esc(p.customerName || "-")}</td></tr>
      <tr><th>Amount Paid</th><td>${fmtMoney(p.amount)}</td></tr>
      ${appliedCount ? `<tr><th>Applied To</th><td>${appliedCount} sale${appliedCount !== 1 ? "s" : ""}</td></tr>` : ""}
      ${p.note ? `<tr><th>Note</th><td>${esc(p.note)}</td></tr>` : ""}
      <tr><th>Record ID</th><td>${esc(p.id)}</td></tr>
    </table>
    <p style="margin-top:24px;font-size:12px;color:#666;text-align:center;">
      Thank you for your payment! 🙏
    </p>
  `, "Payment");
  showToast("Opening print dialog 🖨️");
}
window.printPayment = printPayment;

export function viewPaymentCustomer(paymentId) {
  const p = state.customerTransactions.find(t => t.id === paymentId);
  if (!p || p.type !== "payment") { showToast("Payment not found ❌"); return; }
  if (!p.customerId) { showToast("Customer not linked ❌"); return; }
  viewCustomer(p.customerId);
}
window.viewPaymentCustomer = viewPaymentCustomer;

/* =========================================================
   BULK UI HELPERS (NEW)
   ========================================================= */
function updatePaymentsBulkUI() {
  const bar       = $("payments-bulk-bar");
  const countEl   = $("payments-selected-count");
  const delBtn    = $("payments-delete-selected");
  const selectAll = $("payments-select-all");
  const list      = $("utang-payment-history");

  const hasRows = !!(list && list.querySelector(".payment-row"));
  if (bar) bar.classList.toggle("hidden", !hasRows);

  if (countEl) countEl.textContent = `${selectedPayments.size} selected`;
  if (delBtn) delBtn.disabled = selectedPayments.size === 0;

  const cbs = list ? [...list.querySelectorAll(".payment-row-checkbox")] : [];
  if (selectAll) {
    const allChecked = cbs.length > 0 && cbs.every(cb => cb.checked);
    const anyChecked = cbs.some(cb => cb.checked);
    selectAll.checked = allChecked;
    selectAll.indeterminate = !allChecked && anyChecked;
  }
}

function wirePaymentsBulkUI() {
  const selectAll = $("payments-select-all");
  const delBtn    = $("payments-delete-selected");

  if (selectAll && !selectAll.dataset.wired) {
    selectAll.dataset.wired = "1";
    selectAll.addEventListener("change", (e) => {
      const checked = e.target.checked;
      const list = $("utang-payment-history");
      list?.querySelectorAll(".payment-row-checkbox").forEach(cb => {
        cb.checked = checked;
        const id = cb.dataset.id;
        if (checked) selectedPayments.add(id);
        else         selectedPayments.delete(id);
        cb.closest(".payment-row")?.classList.toggle("is-selected", checked);
      });
      updatePaymentsBulkUI();
    });
  }

  if (delBtn && !delBtn.dataset.wired) {
    delBtn.dataset.wired = "1";
    delBtn.addEventListener("click", async () => {
      if (!selectedPayments.size) return;
      const ids = [...selectedPayments];
      if (!confirm(`Delete ${ids.length} payment${ids.length !== 1 ? "s" : ""}?\n\nCustomer balances will be restored and affected sales marked unpaid.`)) return;

      delBtn.disabled = true;
      let ok = 0, fail = 0;
      for (const id of ids) {
        try {
          await reversePaymentSilently(id);
          ok++;
        } catch (err) {
          console.error("[bulk payment delete]", id, err);
          fail++;
        }
      }
      selectedPayments.clear();
      updatePaymentsBulkUI();
      playSuccessSound();
      showToast(`Deleted ${ok} payment${ok !== 1 ? "s" : ""}${fail ? ` · ${fail} failed` : ""} ✅`);
    });
  }
}

/* =========================================================
   RENDER — customer list
   ========================================================= */
function renderCustomers() {
  const list = $("customers-list");
  if (!list) return;
  const term = valOf($("customers-search")).toLowerCase().trim();
  const filtered = state.customers.filter(c => {
    if (!term) return true;
    return (c.name || "").toLowerCase().includes(term)
        || (c.phone || "").toLowerCase().includes(term);
  });

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><p>👥 No customers yet — add one to start tracking utang.</p></div>`;
    return;
  }

  const sorted = [...filtered].sort((a, b) => Number(b.balance || 0) - Number(a.balance || 0));

  list.innerHTML = sorted.map(c => {
    const balance = Number(c.balance) || 0;
    const owes = balance > 0;
    const last = c.lastPurchaseAt?.toDate?.();
    const lastTxt = last ? last.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
    const initial = (c.name || "?").charAt(0).toUpperCase();
    return `
      <div class="customer-card ${owes ? "has-balance" : ""}">
        <div class="customer-avatar">${esc(initial)}</div>
        <div class="customer-main">
          <div class="customer-name">${esc(c.name)}</div>
          <div class="customer-meta">
            ${c.phone ? `📞 ${esc(c.phone)}` : ""}
            ${c.phone && c.address ? " · " : ""}
            ${c.address ? `📍 ${esc(c.address)}` : ""}
          </div>
          <div class="customer-stats">
            <span>💵 ${fmtMoney(c.totalPurchases || 0)} purchases</span>
            <span>🕐 Last: ${lastTxt}</span>
          </div>
          ${owes ? `<div class="customer-balance">Utang: <strong>${fmtMoney(balance)}</strong></div>` : `<div class="customer-balance paid">✅ Fully paid</div>`}
        </div>
        <div class="customer-actions">
          ${owes ? `<button type="button" class="btn primary sm" onclick="recordPayment('${c.id}')">💵 Pay</button>` : ""}
          <button type="button" class="btn ghost sm" onclick="viewCustomer('${c.id}')">👁️</button>
          <button type="button" class="btn ghost sm" onclick="editCustomer('${c.id}')">✏️</button>
          <button type="button" class="btn danger sm" onclick="deleteCustomer('${c.id}')">✕</button>
        </div>
      </div>`;
  }).join("");
}

/* =========================================================
   RENDER — payment history (with bulk selection)
   ========================================================= */
function renderPaymentHistory() {
  const list = $("utang-payment-history");
  if (!list) return;

  const term = valOf($("utang-history-search")).toLowerCase().trim();

  let payments = (state.customerTransactions || [])
    .filter(t => t.type === "payment");

  if (term) {
    payments = payments.filter(t =>
      (t.customerName || "").toLowerCase().includes(term) ||
      (t.note || "").toLowerCase().includes(term)
    );
  }

  payments = payments
    .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0))
    .slice(0, 100);

  if (!payments.length) {
    list.innerHTML = `<div class="empty-state"><p>💵 No payments recorded yet.</p></div>`;
    updatePaymentsBulkUI();
    return;
  }

  const totalShown = payments.reduce((s, t) => s + (Number(t.amount) || 0), 0);

  const header = `
    <div class="utang-history-summary">
      <span>Showing <strong>${payments.length}</strong> payment${payments.length !== 1 ? "s" : ""}</span>
      <span>Total: <strong>${fmtMoney(totalShown)}</strong></span>
    </div>
  `;

  const rows = payments.map(t => {
    const date = t.createdAt?.toDate?.().toLocaleString() || "—";
    const initial = (t.customerName || "?").charAt(0).toUpperCase();
    const isSelected = selectedPayments.has(t.id);
    return `
      <div class="payment-row ${isSelected ? "is-selected" : ""}">
        <label class="history-receipt-check" title="Select payment">
          <input type="checkbox"
                 class="payment-row-checkbox"
                 data-id="${t.id}"
                 ${isSelected ? "checked" : ""} />
        </label>
        <div class="payment-avatar">${esc(initial)}</div>
        <div class="payment-main">
          <div class="payment-name">${esc(t.customerName)}</div>
          <div class="payment-meta">${esc(date)}${t.note ? " · " + esc(t.note) : ""}</div>
        </div>
        <div class="payment-amount">+${fmtMoney(t.amount)}</div>
        <div class="payment-actions">
          <button type="button" class="sale-action-btn receipt" title="View customer" onclick="viewPaymentCustomer('${t.id}')">👁️</button>
          <button type="button" class="sale-action-btn" title="Print receipt" onclick="printPayment('${t.id}')">🖨️</button>
          <button type="button" class="sale-action-btn delete" title="Delete payment" onclick="deletePayment('${t.id}')">🗑️</button>
        </div>
      </div>`;
  }).join("");

  list.innerHTML = header + rows;

  /* Wire per-row checkboxes + bulk bar */
  list.querySelectorAll(".payment-row-checkbox").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.id;
      if (cb.checked) selectedPayments.add(id);
      else            selectedPayments.delete(id);
      cb.closest(".payment-row")?.classList.toggle("is-selected", cb.checked);
      updatePaymentsBulkUI();
    });
  });
  wirePaymentsBulkUI();
  updatePaymentsBulkUI();
}

/* =========================================================
   DETAIL / LEDGER
   ========================================================= */
export function viewCustomer(id) {
  const c = state.customers.find(x => x.id === id);
  if (!c) { showToast("Customer not found ❌"); return; }
  state.currentCustomerId = id;

  const titleEl = $("customer-detail-title");
  if (titleEl) titleEl.textContent = c.name;
  const metaEl = $("customer-detail-meta");
  if (metaEl) {
    metaEl.innerHTML = `
      ${c.phone ? `<span>📞 ${esc(c.phone)}</span>` : ""}
      ${c.address ? `<span>📍 ${esc(c.address)}</span>` : ""}
      <span>💵 Total: ${fmtMoney(c.totalPurchases || 0)}</span>
      <span class="detail-balance ${Number(c.balance) > 0 ? "owes" : "paid"}">
        ${Number(c.balance) > 0 ? `Utang: ${fmtMoney(c.balance)}` : "✅ Paid"}
      </span>`;
  }

  const txns = state.customerTransactions
    .filter(t => t.customerId === id)
    .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));

  const list = $("customer-detail-txns");
  if (list) {
    if (!txns.length) {
      list.innerHTML = `<div class="empty-state"><p>No transactions yet.</p></div>`;
    } else {
      let running = 0;
      const chronological = [...txns].reverse();
      const balances = {};
      chronological.forEach(t => {
        running += t.type === "purchase" ? Number(t.amount) : -Number(t.amount);
        balances[t.id] = running;
      });
      list.innerHTML = txns.map(t => {
        const isPurchase = t.type === "purchase";
        const date = t.createdAt?.toDate?.().toLocaleString() || "—";
        return `
          <div class="txn-row">
            <div class="txn-icon ${isPurchase ? "purchase" : "payment"}">
              ${isPurchase ? "🛒" : "💵"}
            </div>
            <div class="txn-main">
              <div class="txn-title">${isPurchase ? "Credit purchase" : "Payment"}${t.receiptNum ? ` · ${esc(t.receiptNum)}` : ""}</div>
              <div class="txn-meta">${esc(date)}${t.note ? " · " + esc(t.note) : ""}</div>
            </div>
            <div class="txn-amount ${isPurchase ? "out" : "in"}">
              ${isPurchase ? "+" : "−"}${fmtMoney(t.amount)}
            </div>
            <div class="txn-balance">Bal: ${fmtMoney(balances[t.id] || 0)}</div>
          </div>`;
      }).join("");
    }
  }

  $("customer-detail-modal")?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}
window.viewCustomer = viewCustomer;

function closeCustomerDetail() {
  $("customer-detail-modal")?.classList.add("hidden");
  document.body.style.overflow = "";
  state.currentCustomerId = null;
}

function wireCustomerDetail() {
  $("customer-detail-close")?.addEventListener("click", closeCustomerDetail);
  $("customer-detail-modal")?.addEventListener("click", (e) => {
    if (e.target === $("customer-detail-modal")) closeCustomerDetail();
  });
  $("customer-detail-pay")?.addEventListener("click", () => {
    const id = state.currentCustomerId;
    closeCustomerDetail();
    if (id) recordPayment(id);
  });
}

/* =========================================================
   INIT + LISTENERS
   ========================================================= */
export function initCustomers() {
  wireCustomerForm();
  wirePaymentModal();
  wireCustomerDetail();
  $("customers-search")?.addEventListener("input", debounce(renderCustomers, 150));
  $("utang-history-search")?.addEventListener("input", debounce(renderPaymentHistory, 150));

  /* NEW: wire bulk UI once at boot */
  wirePaymentsBulkUI();
  updatePaymentsBulkUI();
}

export function startCustomersListeners(onAfter) {
  const wsId = myWorkspace();
  if (!wsId) return;

  state.unsubscribers.customers = onSnapshot(
    query(collection(db, "customers"), where("workspaceId", "==", wsId)),
    (snap) => {
      state.customers = snap.docs
        .map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      safeRender(renderCustomers);
      safeRender(renderCustomerPickerOptions);
      onAfter?.();
    },
    (err) => console.error("[Customers listener]", err.code, err.message)
  );

  state.unsubscribers.customerTxns = onSnapshot(
    query(collection(db, "customer_transactions"), where("workspaceId", "==", wsId)),
    (snap) => {
      state.customerTransactions = snap.docs
        .map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
        .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0))
        .slice(0, 300);

      safeRender(renderPaymentHistory);
      if (state.currentCustomerId) safeRender(() => viewCustomer(state.currentCustomerId));
    },
    (err) => console.error("[Customer txns listener]", err.code, err.message)
  );
}

/* =========================================================
   POS INTEGRATION — customer picker
   ========================================================= */
export function renderCustomerPickerOptions() {
  const sel = $("pos-customer");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = `<option value="">— Walk-in customer —</option>` +
    state.customers.map(c => {
      const owes = Number(c.balance) > 0 ? ` (utang ${fmtMoney(c.balance)})` : "";
      return `<option value="${c.id}">${esc(c.name)}${owes}</option>`;
    }).join("");
  if (cur && state.customers.some(c => c.id === cur)) sel.value = cur;
}