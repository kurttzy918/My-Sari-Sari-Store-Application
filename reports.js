/* reports.js — Analytics, charts, history, exports */
import {
  collection, doc, writeBatch, serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { state, CONSTANTS } from "./state.js";
import {
  $, valOf, esc, safeRender, showToast, debounce,
  fmtMoney, fmtInt, fmtShort, productImageHTML, thumbHTML,
  fallbackColorFor,
  getSoldMap, getSoldMapLastDays, getSalesByCategory, monthKey, monthLabel,
  getCSSVar, printHTML, downloadXLSX, downloadPDF,
  expiryStatus,
  roundMoney,                                                    // ✅ NEW
  getStoreDisplayName                                            // ✅ NEW
} from "./utils.js";
import { stockProgress, renderPaginationBar } from "./inventory.js";

const { CATEGORY_PALETTE } = CONSTANTS;

/* =========================================================
   LOCAL HELPERS — Expense-aware profit
   -------------------------------------------------
   These compute directly from state so reports.js doesn't
   depend on utils.js exporting extra functions.
   ========================================================= */
function _getGrossProfit() {
  return roundMoney(
    (state.sales || []).reduce((sum, s) => {
      if (typeof s.profit === "number") return sum + s.profit;
      const it = state.inventory.find(i => i.id === s.itemId);
      const cost = (it && typeof it.cost === "number") ? it.cost : (s.cost || 0);
      return sum + ((s.unitPrice || 0) - cost) * (s.quantity || 0);
    }, 0)
  );
}

function _getTotalExpenses() {
  return roundMoney(
    (state.expenses || []).reduce((sum, e) => sum + (Number(e.amount) || 0), 0)
  );
}

function _getNetProfit() {
  return roundMoney(_getGrossProfit() - _getTotalExpenses());
}

/* =========================================================
   HISTORY BULK-SELECTION STATE
   ========================================================= */
const selectedReceipts = new Set();

/* =========================================================
   STATS (stat cards) — now shows NET PROFIT
   ========================================================= */
export function updateStats() {
  const total = state.inventory.length;
  const low = state.inventory.filter(i => i.quantity <= (i.threshold ?? 5)).length;
  const value = state.inventory.reduce((s, i) => s + (i.quantity * i.price || 0), 0);
  const runningSales = state.sales.reduce((s, x) => s + (Number(x.total) || 0), 0);

  /* ---------- Profit = gross profit from sales only ---------- */
  const grossProfit = _getGrossProfit();

  if ($("stat-total"))  $("stat-total").textContent = fmtInt(total);
  if ($("stat-low"))    $("stat-low").textContent = fmtInt(low);
  if ($("stat-value"))  $("stat-value").textContent = fmtMoney(value);
  if ($("stat-sales"))  $("stat-sales").textContent = fmtMoney(runningSales);
  if ($("stat-cats"))   $("stat-cats").textContent = fmtInt(state.categories.length);

  const profitEl = $("stat-profit");
  if (profitEl) {
    profitEl.textContent = fmtMoney(grossProfit);
    // Remove any leftover sub-line from a previous render
    const oldSub = profitEl.parentElement.querySelector(".stat-sub");
    if (oldSub) oldSub.remove();
    profitEl.title = "Gross profit from sales";
  }
}

/* =========================================================
   SALES OVERVIEW
   ========================================================= */
export function populateMonthFilter() {
  const sel = $("month-filter"); if (!sel) return;
  const set = new Set();
  state.sales.forEach(s => {
    const d = s.createdAt?.toDate?.(); if (d) set.add(monthKey(d));
  });
  const list = [...set].sort().reverse();
  const cur = sel.value || state.soSelectedMonth;
  sel.innerHTML = `<option value="">All Time</option>` +
    list.map(k => `<option value="${k}">${esc(monthLabel(k))}</option>`).join("");
  sel.value = list.includes(cur) ? cur : "";
  state.soSelectedMonth = sel.value;
}

export function populateSalesCategoryFilter() {
  const sel = $("sales-cat-analytics-filter");
  if (!sel) return;
  const cur = sel.value;
  const cats = new Set();
  state.sales.forEach(s => { if (s.category) cats.add(s.category); });
  state.inventory.forEach(i => { if (i.category) cats.add(i.category); });
  const list = [...cats].sort((a, b) => a.localeCompare(b));
  sel.innerHTML = `<option value="">All Categories</option>` +
    list.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  if (cur && list.includes(cur)) sel.value = cur;
}

export function renderSalesOverview() {
  const todayEl   = $("so-today");
  const monthEl   = $("so-month");
  const weekEl    = $("so-week");
  const runningEl = $("so-running");
  if (!todayEl || !monthEl || !runningEl) return;

  const now = new Date();
  const runningTotal = state.sales.reduce((a, s) => a + (Number(s.total) || 0), 0);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayTotal = state.sales
    .filter(s => (s.createdAt?.toDate?.() ?? 0) >= today)
    .reduce((a, s) => a + (Number(s.total) || 0), 0);

  const mk = valOf($("month-filter")) || state.soSelectedMonth || "";
  const monthSalesList = mk
    ? state.sales.filter(s => {
        const d = s.createdAt?.toDate?.();
        return d && monthKey(d) === mk;
      })
    : state.sales;
  const monthTotal = monthSalesList.reduce((a, s) => a + (Number(s.total) || 0), 0);

  const weekStart = new Date(now);
  const dayOfWeek = (now.getDay() + 6) % 7;
  weekStart.setDate(now.getDate() - dayOfWeek);
  weekStart.setHours(0, 0, 0, 0);
  const weekTotal = state.sales
    .filter(s => (s.createdAt?.toDate?.() ?? 0) >= weekStart)
    .reduce((a, s) => a + (Number(s.total) || 0), 0);

  todayEl.textContent = fmtMoney(todayTotal);
  monthEl.textContent = fmtMoney(monthTotal);
  if (weekEl) weekEl.textContent = fmtMoney(weekTotal);
  runningEl.textContent = fmtMoney(runningTotal);

  const dailyMap = {};
  monthSalesList.forEach(s => {
    const d = s.createdAt?.toDate?.(); if (!d) return;
    const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    dailyMap[k] = (dailyMap[k] || 0) + (Number(s.total) || 0);
  });
  const days = Object.entries(dailyMap).sort((a, b) => b[0].localeCompare(a[0]));
  const maxDay = days.reduce((m, [, v]) => Math.max(m, v), 0);

  const listEl = $("so-daily-list"), totalEl = $("so-daily-total");
  if (totalEl) totalEl.textContent = fmtMoney(monthTotal);
  if (!listEl) return;
  if (!days.length) {
    listEl.innerHTML = `<div class="empty-state"><p>No sales in this period.</p></div>`;
    return;
  }

  listEl.innerHTML = days.map(([k, v]) => {
    const d = new Date(k + "T00:00:00");
    const label = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const best = maxDay > 0 && v === maxDay && days.length > 1;
    const pct = maxDay > 0 ? (v / maxDay) * 100 : 0;
    return `
      <div class="daily-row ${best ? "is-best" : ""}">
        <span class="daily-row-date">
          ${esc(label)}${best ? `<span class="daily-row-badge">🏆</span>` : ""}
        </span>
        <span class="daily-row-bar">
          <span class="daily-row-bar-fill" style="width:${pct}%"></span>
        </span>
        <span class="daily-row-amount">${fmtMoney(v)}</span>
      </div>
    `;
  }).join("");
}

/* =========================================================
   ADVANCED ANALYTICS — KPI cards (net profit margin)
   ========================================================= */
export function renderKPIs() {
  const salesArr = state.sales;

  const receiptSet = new Set(salesArr.map(s => s.receiptNum || s.id));
  const totalSales = salesArr.reduce((a, s) => a + (Number(s.total) || 0), 0);
  const aov = receiptSet.size ? totalSales / receiptSet.size : 0;
  if ($("kpi-aov")) $("kpi-aov").textContent = fmtMoney(aov);

  const itemsSold = salesArr.reduce((a, s) => a + (Number(s.quantity) || 0), 0);
  if ($("kpi-items")) $("kpi-items").textContent = fmtInt(itemsSold);

  const hourBuckets = new Array(24).fill(0);
  salesArr.forEach(s => {
    const d = s.createdAt?.toDate?.(); if (!d) return;
    hourBuckets[d.getHours()] += 1;
  });
  const peakH = hourBuckets.indexOf(Math.max(...hourBuckets));
  const peakCount = hourBuckets[peakH];
  if ($("kpi-peak")) $("kpi-peak").textContent = peakCount > 0
    ? `${String(peakH).padStart(2,"0")}:00`
    : "–";

   /* ---------- Profit Margin — gross (sales only) ---------- */
  const grossProfit = _getGrossProfit();
  const margin = totalSales > 0 ? (grossProfit / totalSales) * 100 : 0;

  const marginEl = $("kpi-margin");
  if (marginEl) {
    marginEl.textContent = margin.toFixed(1) + "%";
    marginEl.title = "Gross profit margin from sales";
  }
}

function buildLast30DaySeries(getValue) {
  const days = [];
  const now = new Date(); now.setHours(0,0,0,0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    days.push({ date: d, key: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}` });
  }
  const sums = {};
  days.forEach(d => sums[d.key] = 0);
  state.sales.forEach(s => {
    const dt = s.createdAt?.toDate?.(); if (!dt) return;
    const k = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
    if (k in sums) sums[k] += getValue(s);
  });
  return {
    labels: days.map(d => d.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })),
    values: days.map(d => sums[d.key])
  };
}

/* =========================================================
   TREND CHARTS — Last 30 Days
   ========================================================= */
export function renderTrendCharts() {
  const salesCanvas  = $("sales-trend-chart");
  const profitCanvas = $("profit-trend-chart");
  if (!salesCanvas || !profitCanvas) return;

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";

  const tickColor   = isDark ? "#9DB3B0" : "#64748B";
  const gridColor   = isDark ? "rgba(255,255,255,0.08)" : "rgba(15,23,42,0.10)";
  const axisColor   = isDark ? "rgba(255,255,255,0.18)" : "rgba(15,23,42,0.18)";
  const tooltipBg   = isDark ? "#1E2D34" : "#0F172A";

  const salesSeries = buildLast30DaySeries(s => Number(s.total) || 0);
  const profitSeries = buildLast30DaySeries(s => {
    if (typeof s.profit === "number") return s.profit;
    const it = state.inventory.find(i => i.id === s.itemId);
    const cost = (it && typeof it.cost === "number") ? it.cost : (s.cost || 0);
    return ((s.unitPrice || 0) - cost) * (s.quantity || 0);
  });

  const barOpts = (label) => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 500, easing: "easeOutQuart" },
    layout: { padding: { top: 8, right: 8, bottom: 0, left: 0 } },
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: tooltipBg,
        titleColor: "#fff",
        bodyColor: "#fff",
        padding: 12,
        cornerRadius: 10,
        displayColors: false,
        titleFont: { size: 11, weight: "700" },
        bodyFont: { size: 12, weight: "600" },
        callbacks: { label: (c) => `${label}: ${fmtMoney(c.parsed.y)}` }
      }
    },
    scales: {
      x: {
        ticks: {
          color: tickColor,
          font: { size: 10, weight: "600" },
          maxRotation: 0, autoSkip: true, maxTicksLimit: 8, padding: 6
        },
        grid: { display: false, drawTicks: false },
        border: { display: true, color: axisColor, width: 1 }
      },
      y: {
        beginAtZero: true,
        ticks: {
          color: tickColor,
          font: { size: 10, weight: "600" },
          padding: 8, maxTicksLimit: 5,
          callback: (v) => fmtShort(v)
        },
        grid: {
          color: gridColor,
          drawTicks: false,
          drawBorder: false,
          lineWidth: 1,
          borderDash: [4, 4]
        },
        border: { display: true, color: axisColor, width: 1, dash: [0, 0] }
      }
    }
  });

  /* ---------- Sales ---------- */
  const sData = {
    labels: salesSeries.labels,
    datasets: [{
      label: "Sales",
      data: salesSeries.values,
      backgroundColor: isDark ? "#2FA38F" : "#12544F",
      hoverBackgroundColor: "#5FC2A6",
      borderRadius: 6,
      borderSkipped: false,
      maxBarThickness: 32,
      categoryPercentage: 0.7,
      barPercentage: 0.85
    }]
  };
  if (state.salesTrendChart?.canvas?.isConnected) state.salesTrendChart.destroy();
  try {
    state.salesTrendChart = new Chart(salesCanvas, {
      type: "bar", data: sData, options: barOpts("Sales")
    });
  } catch (e) { console.error("[bar chart sales]", e); }

  /* ---------- Profit ---------- */
  const pData = {
    labels: profitSeries.labels,
    datasets: [{
      label: "Profit",
      data: profitSeries.values,
      backgroundColor: isDark ? "#10B981" : "#059669",
      hoverBackgroundColor: "#34D399",
      borderRadius: 6,
      borderSkipped: false,
      maxBarThickness: 32,
      categoryPercentage: 0.7,
      barPercentage: 0.85
    }]
  };
  if (state.profitTrendChart?.canvas?.isConnected) state.profitTrendChart.destroy();
  try {
    state.profitTrendChart = new Chart(profitCanvas, {
      type: "bar", data: pData, options: barOpts("Profit")
    });
  } catch (e) { console.error("[bar chart profit]", e); }
}

export function renderTopProfitAndRevenue() {
  const listProfit  = $("top-profit-list");
  const listRevenue = $("top-revenue-list");
  if (!listProfit && !listRevenue) return;

  const byProfit  = {};
  const byRevenue = {};

  state.sales.forEach(s => {
    const profit = typeof s.profit === "number"
      ? s.profit
      : (() => {
          const it = state.inventory.find(i => i.id === s.itemId);
          const cost = (it && typeof it.cost === "number") ? it.cost : (s.cost || 0);
          return ((s.unitPrice || 0) - cost) * (s.quantity || 0);
        })();
    const rev = Number(s.total) || 0;
    const invItem = state.inventory.find(i => i.id === s.itemId);
    const image = invItem?.image || s.image || null;
    const cat = s.category || invItem?.category || "Uncategorized";

    if (!byProfit[s.itemId]) {
      byProfit[s.itemId] = { itemId: s.itemId, name: s.itemName, image, category: cat, profit: 0, qty: 0, revenue: 0 };
    }
    byProfit[s.itemId].profit  += profit;
    byProfit[s.itemId].qty     += Number(s.quantity) || 0;
    byProfit[s.itemId].revenue += rev;

    if (!byRevenue[s.itemId]) {
      byRevenue[s.itemId] = { itemId: s.itemId, name: s.itemName, image, category: cat, revenue: 0, qty: 0, profit: 0 };
    }
    byRevenue[s.itemId].revenue += rev;
    byRevenue[s.itemId].qty     += Number(s.quantity) || 0;
    byRevenue[s.itemId].profit  += profit;
  });

  const buildRows = (arr, valueKey, valueLabel, barClass) => {
    if (!arr.length) {
      return `<div class="rk-empty">No data yet — make a sale to see rankings.</div>`;
    }
    const maxVal = arr[0][valueKey] || 1;

    return arr.slice(0, 5).map((it, idx) => {
      const rankClass = idx === 0 ? "rank-1" : idx === 1 ? "rank-2" : idx === 2 ? "rank-3" : "";
      const pct = (it[valueKey] / maxVal) * 100;
      const invItem = state.inventory.find(i => i.id === it.itemId) || {
        id: it.itemId, name: it.name, image: it.image || null
      };
      const imgHTML = invItem.image
        ? `<img src="${esc(invItem.image)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
        : `<div class="rk-fallback" style="background:${fallbackColorFor(invItem.name)}">${esc((invItem.name || "?").charAt(0).toUpperCase())}</div>`;

      return `
        <div class="rk-row ${idx === 0 ? "is-top" : ""}">
          <div class="rk-rank ${rankClass}">${idx + 1}</div>
          <div class="rk-img">${imgHTML}</div>
          <div class="rk-body">
            <div class="rk-name" title="${esc(it.name)}">${esc(it.name)}</div>
            <div class="rk-sub">
              ${fmtInt(it.qty)} sold · ${esc(it.category || "")}
            </div>
            <div class="rk-bar">
              <div class="rk-bar-fill ${barClass}" style="width:${pct}%"></div>
            </div>
          </div>
          <div class="rk-value ${barClass}">
            ${fmtMoney(it[valueKey])}
            <span class="rk-unit">${valueLabel}</span>
          </div>
        </div>
      `;
    }).join("");
  };

  const profitArr  = Object.values(byProfit).sort((a, b) => b.profit - a.profit);
  const revenueArr = Object.values(byRevenue).sort((a, b) => b.revenue - a.revenue);

  if (listProfit)  listProfit.innerHTML  = buildRows(profitArr,  "profit",  "Profit",  "profit");
  if (listRevenue) listRevenue.innerHTML = buildRows(revenueArr, "revenue", "Revenue", "");
}

/* =========================================================
   CHART CENTER TEXT PLUGIN
   ========================================================= */
const centerTextPlugin = {
  id: "centerText",
  afterDraw(chart) {
    const opts = chart.options?.plugins?.centerText;
    if (!opts || !opts.text) return;

    const { ctx, chartArea } = chart;
    if (!chartArea) return;

    const isHalf = opts.half === true;
    const centerX = (chartArea.left + chartArea.right) / 2;
    const centerY = isHalf
      ? chartArea.bottom - 6
      : (chartArea.top + chartArea.bottom) / 2;

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.font = `800 ${opts.size || 20}px 'Plus Jakarta Sans', -apple-system, sans-serif`;
    ctx.fillStyle = opts.color || "#0F172A";
    ctx.fillText(opts.text, centerX, isHalf ? centerY - 34 : centerY - 8);

    if (opts.subtext) {
      ctx.font = `700 ${opts.subSize || 10}px 'Plus Jakarta Sans', -apple-system, sans-serif`;
      ctx.fillStyle = opts.subColor || "#64748B";
      ctx.fillText(opts.subtext, centerX, isHalf ? centerY - 16 : centerY + 14);
    }

    ctx.restore();
  }
};

/* =========================================================
   CHARTS — Sales vs Cost + Sales by Category
   ========================================================= */
export function renderCharts(retries = 0) {
  if (!state.chartJsReady || typeof Chart === "undefined") {
    if (retries < 40) setTimeout(() => renderCharts(retries + 1), 200);
    return;
  }
  const dashEl = $("page-dashboard");
  if (!dashEl || dashEl.classList.contains("hidden")) return;

  const svcCanvas = $("sales-vs-cost-chart");
  const salesCatCanvas = $("sales-category-chart");
  if (!svcCanvas || !salesCatCanvas) return;
  if (svcCanvas.clientWidth <= 0 || svcCanvas.clientHeight <= 0) {
    if (retries < 40) setTimeout(() => renderCharts(retries + 1), 200);
    return;
  }

  const textColor = getCSSVar("--text") || "#1e293b";
  const subtleColor = getCSSVar("--text-secondary") || "#64748b";
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";

  /* ---------- 1) Where Your Sales Went ---------- */
  try {
    const totalSales = state.sales.reduce((s, x) => s + (Number(x.total) || 0), 0);
    const totalCost = state.sales.reduce((s, x) => {
      const unitCost = Number(x.cost) || 0;
      const qty = Number(x.quantity) || 0;
      return s + (unitCost * qty);
    }, 0);
    const totalProfit = totalSales - totalCost;
    const profitMargin = totalSales > 0 ? (totalProfit / totalSales) * 100 : 0;

    const stockValue  = state.inventory.reduce((s, i) => s + (i.quantity * i.price || 0), 0);
    const stockCost   = state.inventory.reduce((s, i) => s + (i.quantity * (i.cost || 0)), 0);
    const stockProfit = stockValue - stockCost;
    const stockCount  = state.inventory.reduce((s, i) => s + (Number(i.quantity) || 0), 0);

    const infoEl = $("sales-vs-cost-info");
    if (infoEl) {
      infoEl.innerHTML = `
        <div class="svc-split">
          <div class="svc-side">
            <div class="svc-side-title">🔵 From items you sold</div>
            <div class="svc-row">
              <span class="svc-label">Sales Revenue</span>
              <strong class="svc-value sales">${fmtMoney(totalSales)}</strong>
            </div>
            <div class="svc-row">
              <span class="svc-label">Cost of those items</span>
              <strong class="svc-value cost">− ${fmtMoney(totalCost)}</strong>
            </div>
            <div class="svc-divider"></div>
            <div class="svc-row highlight">
              <span class="svc-label">Your Profit</span>
              <strong class="svc-value profit">${fmtMoney(totalProfit)}</strong>
            </div>
            <div class="svc-row">
              <span class="svc-label">Profit margin</span>
              <strong class="svc-value margin">${profitMargin.toFixed(1)}%</strong>
            </div>
          </div>

          <div class="svc-side separate">
            <div class="svc-side-title">🟢 Still on your shelves</div>
            <div class="svc-row">
              <span class="svc-label">Stock Value</span>
              <strong class="svc-value stock">${fmtMoney(stockValue)}</strong>
            </div>
            <div class="svc-row">
              <span class="svc-label">Stock Cost</span>
              <strong class="svc-value stock-cost">− ${fmtMoney(stockCost)}</strong>
            </div>
            <div class="svc-divider"></div>
            <div class="svc-row highlight stock">
              <span class="svc-label">Potential profit if all sold</span>
              <strong class="svc-value stock-profit">${fmtMoney(stockProfit)}</strong>
            </div>
            <div class="svc-row">
              <span class="svc-label">Items on shelf</span>
              <strong class="svc-value margin">${fmtInt(stockCount)} pcs</strong>
            </div>
          </div>
        </div>

        <div class="svc-note">
          💡 These are the breakdown for Sales Vs Cost
        </div>
      `;
    }

    if (state.salesVsCostChart?.canvas?.isConnected) state.salesVsCostChart.destroy();
    state.salesVsCostChart = new Chart(svcCanvas, {
      type: "doughnut",
      data: {
        labels: ["Cost of Sold Items", "Profit Earned"],
        datasets: [{
          data: [Math.max(0, totalCost), Math.max(0, totalProfit)],
          backgroundColor: ["#3B82F6", "#10B981"],
          hoverBackgroundColor: ["#2563EB", "#059669"],
          borderWidth: 0,
          hoverOffset: 6
        }]
      },
      plugins: [centerTextPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        rotation: -90,
        circumference: 180,
        cutout: "62%",
        animation: { duration: 500, easing: "easeOutQuart" },
        layout: { padding: { top: 8, bottom: 20, left: 12, right: 12 } },
        plugins: {
          legend: { display: false },
          centerText: {
            half: true,
            text: fmtMoney(totalSales),
            subtext: "TOTAL SALES REVENUE",
            color: isDark ? "#E7F3F1" : "#0F172A",
            subColor: subtleColor,
            size: 22,
            subSize: 10
          },
          tooltip: {
            backgroundColor: isDark ? "#1E2D34" : "#0F172A",
            titleColor: "#fff",
            bodyColor: "#fff",
            padding: 12,
            cornerRadius: 10,
            displayColors: true,
            callbacks: {
              label: (c) => {
                const pct = totalSales > 0 ? ((c.parsed / totalSales) * 100).toFixed(1) : "0.0";
                return `  ${c.label}: ${fmtMoney(c.parsed)}  (${pct}%)`;
              }
            }
          }
        }
      }
    });
  } catch (e) { console.error("[chart] sales vs cost:", e); }

  /* ---------- 2) Sales by Category ---------- */
  try {
    const catFilter = (valOf($("sales-cat-analytics-filter")) || "").trim();
    let labels = [];
    let values = [];

    const summaryEl = $("sales-cat-summary");
    const catEl     = $("scs-category");
    const totalEl   = $("scs-total");
    const txnsEl    = $("scs-txns");
    const unitsEl   = $("scs-units");

    const filteredSales = catFilter
      ? state.sales.filter(s => {
          const sc = (s.category || "Uncategorized");
          return sc.trim().toLowerCase() === catFilter.trim().toLowerCase();
        })
      : state.sales;

    if (catFilter) {
      const productMap = {};
      filteredSales.forEach(s => {
        const key = s.itemName || "Unknown";
        if (!productMap[key]) productMap[key] = { total: 0, qty: 0, txns: 0 };
        productMap[key].total += Number(s.total) || 0;
        productMap[key].qty   += Number(s.quantity) || 0;
        productMap[key].txns  += 1;
      });

      const entries = Object.entries(productMap)
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 8);

      labels = entries.map(e => e[0]);
      values = entries.map(e => e[1].total);

      const totalAmount = filteredSales.reduce((sum, s) => sum + (Number(s.total) || 0), 0);
      const totalUnits  = filteredSales.reduce((sum, s) => sum + (Number(s.quantity) || 0), 0);
      const totalTxns   = filteredSales.length;
      const productCount = Object.keys(productMap).length;

      if (catEl)   catEl.textContent   = catFilter;
      if (totalEl) totalEl.textContent = fmtMoney(totalAmount);
      if (txnsEl)  txnsEl.textContent  = fmtInt(totalTxns);
      if (unitsEl) unitsEl.textContent = fmtInt(totalUnits);

      const extraEl = $("scs-products");
      if (extraEl) {
        extraEl.innerHTML = `🏷️ <strong>${fmtInt(productCount)}</strong> product${productCount !== 1 ? "s" : ""} in this category`;
      }

      summaryEl?.classList.remove("hidden");
    } else {
      const catMap = {};
      state.sales.forEach(s => {
        const k = s.category || "Uncategorized";
        if (!catMap[k]) catMap[k] = { total: 0, qty: 0, txns: 0 };
        catMap[k].total += Number(s.total) || 0;
        catMap[k].qty   += Number(s.quantity) || 0;
        catMap[k].txns  += 1;
      });
      const entries = Object.entries(catMap).sort((a, b) => b[1].total - a[1].total);
      labels = entries.map(e => e[0]);
      values = entries.map(e => e[1].total);
      summaryEl?.classList.add("hidden");
    }

    if (!labels.length) {
      labels = ["No sales yet"];
      values = [1];
    }

    const colors = labels.map((_, i) => CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]);
    const totalValues = values.reduce((a, b) => a + b, 0);

    if (state.salesCategoryChart?.canvas?.isConnected) state.salesCategoryChart.destroy();
    state.salesCategoryChart = new Chart(salesCatCanvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          hoverBackgroundColor: colors,
          borderWidth: 2,
          borderColor: isDark ? "#162228" : "#FFFFFF",
          hoverOffset: 8
        }]
      },
      plugins: [centerTextPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "60%",
        animation: { duration: 500, easing: "easeOutQuart" },
        layout: { padding: { top: 8, bottom: 8, left: 4, right: 4 } },
        plugins: {
          legend: {
            position: "bottom",
            align: "center",
            labels: {
              color: textColor,
              padding: 10,
              font: { size: 11, weight: "600" },
              boxWidth: 10,
              boxHeight: 10,
              usePointStyle: true,
              pointStyle: "circle",
              generateLabels: (chart) => {
                const data = chart.data;
                const total = data.datasets[0].data.reduce((a, b) => a + b, 0);
                return data.labels.map((label, i) => {
                  const val = data.datasets[0].data[i] || 0;
                  const pct = total > 0 ? ((val / total) * 100).toFixed(1) : "0.0";
                  const shortLabel = label.length > 18 ? label.slice(0, 17) + "…" : label;
                  return {
                    text: `${shortLabel}  ·  ${pct}%`,
                    fillStyle: data.datasets[0].backgroundColor[i],
                    strokeStyle: data.datasets[0].backgroundColor[i],
                    lineWidth: 0,
                    fontColor: textColor,
                    pointStyle: "circle",
                    hidden: false,
                    index: i
                  };
                });
              }
            }
          },
          centerText: {
            half: false,
            text: fmtMoney(totalValues),
            subtext: catFilter ? catFilter.toUpperCase() : `${labels.length} CATEGOR${labels.length === 1 ? "Y" : "IES"}`,
            color: isDark ? "#E7F3F1" : "#0F172A",
            subColor: subtleColor,
            size: 20,
            subSize: 9
          },
          tooltip: {
            backgroundColor: isDark ? "#1E2D34" : "#0F172A",
            titleColor: "#fff",
            bodyColor: "#fff",
            padding: 12,
            cornerRadius: 10,
            displayColors: true,
            callbacks: {
              title: (items) => items[0]?.label || "",
              label: (c) => {
                const total = c.dataset.data.reduce((a, b) => a + b, 0);
                const pct = total > 0 ? ((c.parsed / total) * 100).toFixed(1) : "0.0";
                return `  ${fmtMoney(c.parsed)}  (${pct}%)`;
              }
            }
          }
        }
      }
    });
  } catch (e) { console.error("[chart] sales category:", e); }

  renderTrendCharts();

  requestAnimationFrame(() => {
    [state.salesVsCostChart, state.salesCategoryChart,
     state.salesTrendChart, state.profitTrendChart].forEach(c => {
      try { c?.resize(); } catch {}
    });
  });
}

export function destroyCharts() {
  [
    state.salesVsCostChart,
    state.salesCategoryChart,
    state.salesTrendChart,
    state.profitTrendChart,
    state.stockChart,
    state.categoryValueChart
  ].forEach(c => { try { c?.destroy(); } catch {} });

  state.salesVsCostChart = null;
  state.salesCategoryChart = null;
  state.salesTrendChart = null;
  state.profitTrendChart = null;
  state.stockChart = null;
  state.categoryValueChart = null;
}

/* =========================================================
   HISTORY — with pagination + bulk selection
   ========================================================= */
export function groupSalesByReceipt() {
  const map = new Map();
  state.sales.forEach(s => {
    const key = s.receiptNum || ("LEGACY-" + s.id);
    if (!map.has(key)) {
      map.set(key, {
        receiptNum: key,
        date: s.createdAt?.toDate?.() || new Date(),
        cashier: (s.userId === state.currentUser?.uid ? state.currentUser?.email : "") || "Store",
        cash: s.cash || 0,
        change: s.change || 0,
        items: [], saleIds: [], total: 0
      });
    }
    const g = map.get(key);
    g.items.push(s); g.saleIds.push(s.id); g.total += (s.total || 0);
  });
  return [...map.values()].sort((a, b) => b.date - a.date);
}

function updateHistoryBulkUI() {
  const bar       = $("history-bulk-bar");
  const countEl   = $("history-selected-count");
  const delBtn    = $("history-delete-selected");
  const selectAll = $("history-select-all");
  const list      = $("history-list");

  const hasRows = !!(list && list.querySelector(".history-receipt"));
  if (bar) bar.classList.toggle("hidden", !hasRows);

  if (countEl) countEl.textContent = `${selectedReceipts.size} selected`;
  if (delBtn) delBtn.disabled = selectedReceipts.size === 0;

  const cbs = list ? [...list.querySelectorAll(".history-receipt-checkbox")] : [];
  if (selectAll) {
    const allChecked = cbs.length > 0 && cbs.every(cb => cb.checked);
    const anyChecked = cbs.some(cb => cb.checked);
    selectAll.checked = allChecked;
    selectAll.indeterminate = !allChecked && anyChecked;
  }
}

function wireHistoryBulkUI() {
  const selectAll = $("history-select-all");
  const delBtn    = $("history-delete-selected");

  if (selectAll && !selectAll.dataset.wired) {
    selectAll.dataset.wired = "1";
    selectAll.addEventListener("change", (e) => {
      const checked = e.target.checked;
      const list = $("history-list");
      list?.querySelectorAll(".history-receipt-checkbox").forEach(cb => {
        cb.checked = checked;
        const rn = cb.dataset.receipt;
        if (checked) selectedReceipts.add(rn);
        else         selectedReceipts.delete(rn);
        cb.closest(".history-receipt")?.classList.toggle("is-selected", checked);
      });
      updateHistoryBulkUI();
    });
  }

  if (delBtn && !delBtn.dataset.wired) {
    delBtn.dataset.wired = "1";
    delBtn.addEventListener("click", async () => {
      if (!selectedReceipts.size) return;
      const groups = groupSalesByReceipt();
      const ids = [];
      groups.forEach(g => {
        if (selectedReceipts.has(g.receiptNum)) ids.push(...g.saleIds);
      });
      if (!ids.length) return;

      const n = selectedReceipts.size;
      if (!confirm(`Delete ${n} receipt${n !== 1 ? "s" : ""}?\n\n${ids.length} sale${ids.length !== 1 ? "s" : ""} will be removed and quantities restored to inventory.`)) return;

      delBtn.disabled = true;
      const mod = await import("./pos.js");
      await mod.deleteSaleIds(ids, { skipConfirm: true, label: "Bulk history delete" });
      selectedReceipts.clear();
      renderHistory();
    });
  }
}

export function renderHistory() {
  const list = $("history-list"); if (!list) return;
  let groups = groupSalesByReceipt();

  const range = valOf($("history-filter")) || "all";
  if (range !== "all") {
    const now = Date.now(); const dayMs = 24 * 60 * 60 * 1000;
    let cutoff = 0;
    if (range === "today") { const t = new Date(); t.setHours(0,0,0,0); cutoff = t.getTime(); }
    else if (range === "7") cutoff = now - 7 * dayMs;
    else if (range === "30") cutoff = now - 30 * dayMs;
    groups = groups.filter(g => g.date.getTime() >= cutoff);
  }

  const catFilter = valOf($("history-cat-filter"));
  if (catFilter) {
    groups = groups.map(g => {
      const items = g.items.filter(it => (it.category || "Uncategorized") === catFilter);
      if (!items.length) return null;
      const total = items.reduce((s, it) => s + (it.total || 0), 0);
      return { ...g, items, total, saleIds: items.map(it => it.id) };
    }).filter(Boolean);
  }

  const term = valOf($("history-search")).toLowerCase().trim();
  if (term) {
    groups = groups.filter(g =>
      g.receiptNum.toLowerCase().includes(term) ||
      (g.cashier || "").toLowerCase().includes(term) ||
      g.items.some(it => (it.itemName || "").toLowerCase().includes(term))
    );
  }

  if (!groups.length) {
    list.innerHTML = `<div class="empty-state"><p>🧾 No sales history found.</p></div>`;
    renderPaginationBar("history-pagination", 0, 1, 1, () => {});
    updateHistoryBulkUI();
    return;
  }

  const pageSize = Math.max(5, state.histPageSize || 15);
  const total = groups.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (state.histPage > totalPages) state.histPage = totalPages;
  if (state.histPage < 1) state.histPage = 1;
  const start = (state.histPage - 1) * pageSize;
  const pageGroups = groups.slice(start, start + pageSize);

  list.innerHTML = pageGroups.map(g => {
    const itemCount = g.items.length;
    const qtyTotal = g.items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
    const timeStr = g.date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const dateStr = g.date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const isCredit = g.items.some(it => it.paymentMode === "credit");
    const isSelected = selectedReceipts.has(g.receiptNum);

    const itemsHTML = g.items.map(it => `
      <div class="history-item-line">
        <span class="history-item-name" title="${esc(it.itemName || "Item")}">
          ${esc(it.itemName || "Item")}
          ${Number(it.quantity) > 1
            ? `<span class="history-item-qty">×${fmtInt(it.quantity)}</span>`
            : ""}
        </span>
        <span class="history-item-price">${fmtMoney(it.total)}</span>
      </div>
    `).join("");

    return `
      <article class="history-receipt ${isSelected ? "is-selected" : ""}"
               data-receipt="${esc(g.receiptNum)}">

        <header class="history-receipt-head">
          <label class="history-receipt-check" title="Select receipt">
            <input type="checkbox"
                   class="history-receipt-checkbox"
                   data-receipt="${esc(g.receiptNum)}"
                   ${isSelected ? "checked" : ""} />
          </label>

          <div class="history-receipt-meta">
            <span class="history-receipt-num">${esc(g.receiptNum)}</span>
            <span class="history-receipt-date">${esc(timeStr)} · ${esc(dateStr)}</span>
          </div>

          <span class="sale-badge ${isCredit ? "credit" : "cash"}">
            ${isCredit ? "📝 Utang" : "💵 Cash"}
          </span>
        </header>

        <div class="history-receipt-items">${itemsHTML}</div>

        <footer class="history-receipt-foot">
          <div class="history-foot-left">
            <span class="history-foot-label">
              ${itemCount} item${itemCount !== 1 ? "s" : ""} · ${fmtInt(qtyTotal)} pc
            </span>
            <span class="history-foot-cashier">
              Cashier: ${esc((g.cashier || "-").slice(0, 22))}
            </span>
          </div>

          <div class="history-foot-total">
            <span class="history-total-label">Total</span>
            <span class="history-total-amount">${fmtMoney(g.total)}</span>
          </div>

          <div class="history-receipt-actions">
            <button type="button" class="sale-btn-icon"
                    data-hact="view" data-receipt="${esc(g.receiptNum)}"
                    title="View receipt" aria-label="View receipt">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                   stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2l-3 2-3-2-3 2-3-2-3 2L4 2z"/>
                <path d="M8 8h8M8 12h8M8 16h5"/>
              </svg>
            </button>
            <button type="button" class="sale-btn-icon"
                    data-hact="print" data-receipt="${esc(g.receiptNum)}"
                    title="Print receipt" aria-label="Print receipt">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                   stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 6 2 18 2 18 9"/>
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
                <rect x="6" y="14" width="12" height="8"/>
              </svg>
            </button>
            <button type="button" class="sale-btn-icon danger"
                    data-hact="delete" data-receipt="${esc(g.receiptNum)}"
                    title="Delete receipt" aria-label="Delete receipt">
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

  list.querySelectorAll(".history-receipt-checkbox").forEach(cb => {
    cb.addEventListener("change", () => {
      const rn = cb.dataset.receipt;
      if (cb.checked) selectedReceipts.add(rn);
      else            selectedReceipts.delete(rn);
      cb.closest(".history-receipt")?.classList.toggle("is-selected", cb.checked);
      updateHistoryBulkUI();
    });
  });

  list.querySelectorAll(".sale-btn-icon[data-hact]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const act = btn.dataset.hact;
      const receiptNum = btn.dataset.receipt;

      if (act === "view")  return viewReceiptGroup(receiptNum);
      if (act === "print") return printReceiptGroup(receiptNum);
      if (act === "delete") return deleteReceiptGroupFromHistory(receiptNum);
    });
  });

  wireHistoryBulkUI();
  updateHistoryBulkUI();

  renderPaginationBar("history-pagination", total, state.histPage, pageSize, (newPage) => {
    state.histPage = newPage;
    renderHistory();
    document.getElementById("history-list")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

export function viewReceiptGroup(receiptNum) {
  const g = groupSalesByReceipt().find(x => x.receiptNum === receiptNum);
  if (!g) { showToast("Receipt not found ❌"); return; }
  import("./pos.js").then(mod => {
    mod.showReceipt({
      items: g.items.map(it => ({ name: it.itemName, qty: it.quantity, price: it.unitPrice || 0 })),
      total: g.total, cash: g.cash || g.total, change: g.change || 0,
      receiptNum: g.receiptNum, date: g.date, cashier: state.currentUser?.email || "-"
    }, { receiptNum: g.receiptNum, saleIds: g.saleIds, total: g.total });
  });
}
window.viewReceiptGroup = viewReceiptGroup;

export function printReceiptGroup(receiptNum) {
  const g = groupSalesByReceipt().find(x => x.receiptNum === receiptNum);
  if (!g) { showToast("Receipt not found ❌"); return; }
  const rows = g.items.map(it => `
    <tr>
      <td>${esc(it.itemName)}</td>
      <td>${fmtInt(it.quantity)}</td>
      <td>${fmtMoney(it.unitPrice, false)}</td>
      <td>${fmtMoney(it.total, false)}</td>
    </tr>`).join("");
  printHTML(`
    <h1>${esc(getStoreDisplayName().toUpperCase())}</h1>
    <div class="meta">Receipt ${esc(g.receiptNum)} · ${esc(g.date.toLocaleString())} · Cashier: ${esc(state.currentUser?.email || "-")}</div>
    <table>
      <thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><th colspan="3" style="text-align:right">TOTAL</th><th>${fmtMoney(g.total, false)}</th></tr>
      </tfoot>
    </table>
  `, "Receipt " + receiptNum);
}
window.printReceiptGroup = printReceiptGroup;

export function deleteReceiptGroupFromHistory(receiptNum) {
  const g = groupSalesByReceipt().find(x => x.receiptNum === receiptNum);
  if (!g) { showToast("Receipt not found ❌"); return; }
  import("./pos.js").then(mod => mod.deleteReceiptGroup(g.saleIds, g.receiptNum));
}
window.deleteReceiptGroupFromHistory = deleteReceiptGroupFromHistory;

/* =========================================================
   CATEGORY SUMMARIES
   ========================================================= */
function renderCategorySummaryInto(container, list, emptyText) {
  if (!container) return;
  const map = getSalesByCategory(list);
  const entries = Object.entries(map).sort((a, b) => b[1].total - a[1].total);
  if (!entries.length) {
    container.innerHTML = `<div class="cat-sum-card empty">${esc(emptyText)}</div>`;
    return;
  }
  container.innerHTML = entries.map(([cat, v]) => `
    <div class="cat-sum-card">
      <div class="cat-sum-name" title="${esc(cat)}">${esc(cat)}</div>
      <div class="cat-sum-total">${fmtMoney(v.total)}</div>
      <div class="cat-sum-meta">${fmtInt(v.count)} sale${v.count !== 1 ? "s" : ""} · ${fmtInt(v.qty)} unit${v.qty !== 1 ? "s" : ""}</div>
    </div>
  `).join("");
}

/* =========================================================
   SALES BY CATEGORY (POS)
   ========================================================= */
export function renderSalesCategorySummary() {
  const container = $("sales-category-summary");
  if (!container) return;

  const map = getSalesByCategory(state.sales);
  const entries = Object.entries(map)
    .map(([cat, v]) => ({
      cat,
      total: v.total,
      count: v.count,
      qty: v.qty,
      avg: v.count ? v.total / v.count : 0
    }))
    .sort((a, b) => b.total - a.total);

  if (!entries.length) {
    container.innerHTML = `<div class="cat-sum-card empty">No sales yet — make a sale to see category totals.</div>`;
    return;
  }

  const grandTotal = entries.reduce((s, e) => s + e.total, 0);
  const maxTotal = entries[0].total || 1;

  container.innerHTML = entries.map((e, i) => {
    const share = grandTotal > 0 ? (e.total / grandTotal) * 100 : 0;
    const barPct = (e.total / maxTotal) * 100;
    const rank = i + 1;

    let rankClass = "";
    if (i === 0) rankClass = "rank-1";
    else if (i === 1) rankClass = "rank-2";
    else if (i === 2) rankClass = "rank-3";

    return `
      <article class="cat-sum-card">
        <header class="cat-sum-head">
          <div class="cat-sum-badge ${rankClass}">${rank}</div>
          <div class="cat-sum-title">
            <div class="cat-sum-name" title="${esc(e.cat)}">${esc(e.cat)}</div>
            <div class="cat-sum-sub">${share.toFixed(1)}% of sales</div>
          </div>
        </header>

        <div class="cat-sum-amount">
          <span class="cat-sum-currency">₱</span>${(e.total).toLocaleString("en-PH", {
            minimumFractionDigits: 2, maximumFractionDigits: 2
          })}
        </div>

        <div class="cat-sum-progress">
          <div class="cat-sum-progress-bar" style="width:${barPct}%"></div>
        </div>

        <footer class="cat-sum-foot">
          <div class="cat-sum-stat">
            <span class="cat-sum-stat-num">${fmtInt(e.count)}</span>
            <span class="cat-sum-stat-lab">Sale${e.count !== 1 ? "s" : ""}</span>
          </div>
          <div class="cat-sum-stat">
            <span class="cat-sum-stat-num">${fmtInt(e.qty)}</span>
            <span class="cat-sum-stat-lab">Unit${e.qty !== 1 ? "s" : ""}</span>
          </div>
          <div class="cat-sum-stat">
            <span class="cat-sum-stat-num">${fmtMoney(e.avg)}</span>
            <span class="cat-sum-stat-lab">Avg Sale</span>
          </div>
        </footer>
      </article>
    `;
  }).join("");
}

export function renderHistoryCategorySummary() {
  let list = state.sales;
  const range = valOf($("history-filter")) || "all";
  if (range !== "all") {
    const now = Date.now(); const dayMs = 24 * 60 * 60 * 1000;
    let cutoff = 0;
    if (range === "today") { const t = new Date(); t.setHours(0,0,0,0); cutoff = t.getTime(); }
    else if (range === "7") cutoff = now - 7 * dayMs;
    else if (range === "30") cutoff = now - 30 * dayMs;
    list = list.filter(s => (s.createdAt?.toMillis?.() ?? 0) >= cutoff);
  }
  const catFilter = valOf($("history-cat-filter"));
  if (catFilter) list = list.filter(s => (s.category || "Uncategorized") === catFilter);
  renderCategorySummaryInto($("history-category-summary"), list, "No sales in this range.");
}

/* =========================================================
   FAST / SLOW MOVING
   ========================================================= */
export function renderFastMoving() {
  const list = $("fast-moving-list"); if (!list) return;
  const soldMap = getSoldMap();

  const ranked = [...state.inventory]
    .map(i => ({ ...i, sold: soldMap[i.id] || 0 }))
    .filter(i => i.sold > 0)
    .sort((a, b) => b.sold - a.sold)
    .slice(0, 5);

  if (!ranked.length) {
    list.innerHTML = `<div class="rk-empty">No sales yet — sell an item to see trends.</div>`;
    return;
  }

  const maxSold = ranked[0].sold || 1;

  list.innerHTML = ranked.map((item, idx) => {
    const rankClass = idx === 0 ? "rank-1" : idx === 1 ? "rank-2" : idx === 2 ? "rank-3" : "";
    const pct = (item.sold / maxSold) * 100;
    const imgHTML = item.image
      ? `<img src="${esc(item.image)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
      : `<div class="rk-fallback" style="background:${fallbackColorFor(item.name)}">${esc((item.name || "?").charAt(0).toUpperCase())}</div>`;

    return `
      <div class="rk-row ${idx === 0 ? "is-top" : ""}">
        <div class="rk-rank ${rankClass}">${idx + 1}</div>
        <div class="rk-img">${imgHTML}</div>
        <div class="rk-body">
          <div class="rk-name" title="${esc(item.name)}">${esc(item.name)}</div>
          <div class="rk-sub">
            SKU ${esc(item.sku)} · ${fmtMoney(item.price)}
          </div>
          <div class="rk-bar">
            <div class="rk-bar-fill" style="width:${pct}%"></div>
          </div>
        </div>
        <div class="rk-value">
          ${fmtInt(item.sold)}
          <span class="rk-unit">sold</span>
        </div>
      </div>
    `;
  }).join("");
}

function getLastSoldMs(itemId) {
  let last = 0;
  state.sales.forEach(s => {
    if (s.itemId !== itemId) return;
    const ms = s.createdAt?.toMillis?.() ?? 0;
    if (ms > last) last = ms;
  });
  return last;
}

export function renderSlowMoving() {
  const list = $("slow-moving-list"); if (!list) return;
  const sold30 = getSoldMapLastDays(30);

  const ranked = [...state.inventory]
    .map(i => ({ ...i, sold30: sold30[i.id] || 0, lastSold: getLastSoldMs(i.id) }))
    .filter(i => i.quantity > 0)
    .sort((a, b) => {
      if (a.sold30 !== b.sold30) return a.sold30 - b.sold30;
      return b.quantity - a.quantity;
    })
    .slice(0, 5);

  if (!ranked.length) {
    list.innerHTML = `<div class="rk-empty">No slow-moving items.</div>`;
    return;
  }

  const maxStock = Math.max(1, ...ranked.map(i => i.quantity));

  list.innerHTML = ranked.map((item, idx) => {
    const lastSoldTxt = item.lastSold
      ? `${Math.floor((Date.now() - item.lastSold) / (24 * 60 * 60 * 1000))}d ago`
      : "Never sold";
    const pct = (item.quantity / maxStock) * 100;
    const imgHTML = item.image
      ? `<img src="${esc(item.image)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
      : `<div class="rk-fallback" style="background:${fallbackColorFor(item.name)}">${esc((item.name || "?").charAt(0).toUpperCase())}</div>`;

    return `
      <div class="rk-row">
        <div class="rk-rank slow">${idx + 1}</div>
        <div class="rk-img">${imgHTML}</div>
        <div class="rk-body">
          <div class="rk-name" title="${esc(item.name)}">${esc(item.name)}</div>
          <div class="rk-sub">
            Last sold: ${lastSoldTxt} · Stock ${fmtInt(item.quantity)}
          </div>
          <div class="rk-bar">
            <div class="rk-bar-fill slow" style="width:${pct}%"></div>
          </div>
        </div>
        <div class="rk-value slow">
          ${fmtInt(item.sold30)}
          <span class="rk-unit">/30d</span>
        </div>
      </div>
    `;
  }).join("");
}

/* =========================================================
   SPOTLIGHT CAROUSEL (legacy)
   ========================================================= */
function buildSlides() {
  const slides = [];
  const soldMap = getSoldMap();
  if (state.inventory.length) {
    const newest = [...state.inventory].sort((a, b) => {
      const ta = a.createdAt?.toMillis?.() ?? 0;
      const tb = b.createdAt?.toMillis?.() ?? 0;
      return tb - ta;
    })[0];
    if (newest) slides.push({
      type: "new", label: "New Arrival", item: newest,
      sold: soldMap[newest.id] || 0, revenue: (soldMap[newest.id] || 0) * (newest.price || 0)
    });
  }
  if (state.inventory.length) {
    const fast = [...state.inventory].sort((a, b) => (soldMap[b.id] || 0) - (soldMap[a.id] || 0))[0];
    if (fast && (soldMap[fast.id] || 0) > 0) slides.push({
      type: "fast", label: "Fast Moving", item: fast,
      sold: soldMap[fast.id] || 0, revenue: (soldMap[fast.id] || 0) * (fast.price || 0)
    });
  }
  if (state.inventory.length) {
    let topItem = null, topRev = 0;
    state.inventory.forEach(item => {
      const rev = (soldMap[item.id] || 0) * (item.price || 0);
      if (rev > topRev) { topRev = rev; topItem = item; }
    });
    if (topItem && topRev > 0) slides.push({
      type: "revenue", label: "Top Revenue", item: topItem,
      sold: soldMap[topItem.id] || 0, revenue: topRev
    });
  }
  if (state.inventory.length) {
    const low = [...state.inventory]
      .filter(i => i.quantity <= (i.threshold ?? 5))
      .sort((a, b) => (a.quantity / (a.threshold ?? 5)) - (b.quantity / (b.threshold ?? 5)))[0];
    if (low) slides.push({
      type: "low", label: "Low Stock", item: low,
      sold: soldMap[low.id] || 0, revenue: (soldMap[low.id] || 0) * (low.price || 0)
    });
  }
  const expiring = state.inventory.filter(i => {
    const e = expiryStatus(i.expiry);
    return e.level === "expiring" || e.level === "expired";
  })[0];
  if (expiring) slides.push({
    type: "expiry", label: "Expiring Soon", item: expiring,
    sold: soldMap[expiring.id] || 0, revenue: (soldMap[expiring.id] || 0) * (expiring.price || 0)
  });
  return slides;
}

export function renderCarousel() {
  const track = $("carousel-track"), dots = $("carousel-dots");
  if (!track || !dots) return;
  state.carouselSlides = buildSlides();
  if (state.carouselIndex >= state.carouselSlides.length) state.carouselIndex = 0;
  if (!state.carouselSlides.length) {
    track.innerHTML = `<div class="carousel-empty">No inventory yet — add items to see spotlight.</div>`;
    dots.innerHTML = ""; stopCarousel(); return;
  }
  track.innerHTML = state.carouselSlides.map((slide, idx) => {
    const item = slide.item;
    const isLow = item.quantity <= (item.threshold ?? 5);
    const { percent, level } = stockProgress(item);
    return `
      <div class="carousel-slide" data-index="${idx}">
        <div class="spotlight-card">
          <div class="spotlight-top">
            <span class="spotlight-badge">${slide.label}</span>
            <span class="badge ${isLow ? "low" : "ok"}">${isLow ? "Low Stock" : "In Stock"}</span>
          </div>
          <div class="spotlight-body">
            <div class="spotlight-thumb">${thumbHTML(item)}</div>
            <div>
              <div class="spotlight-name">${esc(item.name)}</div>
              <div class="spotlight-sku">SKU: ${esc(item.sku)}${item.barcode ? " · " + esc(item.barcode) : ""}</div>
              <div class="spotlight-meta">
                <span>📂 ${esc(item.category)}</span>
                <span>💰 ${fmtMoney(item.price)}</span>
              </div>
            </div>
          </div>
          <div class="spotlight-stats">
            <div class="spot-stat"><span class="spot-num">${fmtInt(slide.sold)}</span><span class="spot-lab">Sold</span></div>
            <div class="spot-stat"><span class="spot-num">${fmtMoney(slide.revenue)}</span><span class="spot-lab">Revenue</span></div>
            <div class="spot-stat"><span class="spot-num">${fmtInt(item.quantity)}</span><span class="spot-lab">Stock</span></div>
          </div>
          <div class="progress-wrap">
            <div class="progress"><div class="progress-bar ${level}" style="width:${percent}%"></div></div>
            <span class="progress-label">${percent.toFixed(0)}%</span>
          </div>
        </div>
      </div>`;
  }).join("");
  dots.innerHTML = state.carouselSlides.map((_, idx) =>
    `<button class="dot ${idx === state.carouselIndex ? "active" : ""}" data-index="${idx}"></button>`).join("");
  dots.querySelectorAll(".dot").forEach(dot => {
    dot.addEventListener("click", () => {
      state.carouselIndex = parseInt(dot.dataset.index);
      updateCarouselPosition(); restartCarousel();
    });
  });
  updateCarouselPosition(); restartCarousel();
}

function updateCarouselPosition() {
  const track = $("carousel-track"), dots = $("carousel-dots");
  if (!state.carouselSlides.length || !track) return;
  track.style.transform = `translateX(-${state.carouselIndex * 100}%)`;
  dots?.querySelectorAll(".dot").forEach((d, i) => d.classList.toggle("active", i === state.carouselIndex));
}
function nextSlide() {
  if (!state.carouselSlides.length) return;
  state.carouselIndex = (state.carouselIndex + 1) % state.carouselSlides.length;
  updateCarouselPosition();
}
function prevSlide() {
  if (!state.carouselSlides.length) return;
  state.carouselIndex = (state.carouselIndex - 1 + state.carouselSlides.length) % state.carouselSlides.length;
  updateCarouselPosition();
}
export function restartCarousel() {
  stopCarousel();
  if (state.carouselSlides.length > 1) state.carouselInterval = setInterval(nextSlide, 5000);
}
export function stopCarousel() {
  if (state.carouselInterval) { clearInterval(state.carouselInterval); state.carouselInterval = null; }
}

/* =========================================================
   EXPORTS (Excel / PDF)
   ========================================================= */
export function exportInventoryToExcel() {
  if (!state.inventory.length) { showToast("No inventory to export ❌"); return; }
  const data = state.inventory.map(i => ({
    Name: i.name, SKU: i.sku, Barcode: i.barcode || "",
    Category: i.category, Quantity: i.quantity,
    "Cost (₱)": Number((i.cost || 0).toFixed(2)),
    "Price (₱)": Number((i.price || 0).toFixed(2)),
    Threshold: i.threshold ?? 5, Expiry: i.expiry || "",
    "Stock Value (₱)": Number(((i.quantity || 0) * (i.price || 0)).toFixed(2))
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Inventory");
  downloadXLSX(wb, `inventory_${new Date().toISOString().slice(0,10)}.xlsx`);
  showToast("Inventory exported ✅");
}
export function exportInventoryToPDF() {
  if (!state.inventory.length) { showToast("No inventory to export ❌"); return; }
  if (!window.jspdf) { showToast("PDF library not loaded ❌"); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(16); doc.text("Inventory Report", 14, 18);
  doc.setFontSize(10); doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 24);
  doc.autoTable({
    startY: 30,
    head: [["Name", "SKU", "Barcode", "Category", "Qty", "Cost", "Price", "Expiry"]],
    body: state.inventory.map(i => [i.name, i.sku, i.barcode || "-", i.category, fmtInt(i.quantity), fmtMoney(i.cost, false), fmtMoney(i.price, false), i.expiry || "-"]),
    styles: { fontSize: 8 }, headStyles: { fillColor: [18, 84, 79] }
  });
  downloadPDF(doc, `inventory_${new Date().toISOString().slice(0,10)}.pdf`);
  showToast("Inventory PDF exported ✅");
}
export function exportSalesToExcel() {
  if (!state.sales.length) { showToast("No sales to export ❌"); return; }
  const data = state.sales.map(s => ({
    Date: s.createdAt?.toDate?.().toLocaleString() ?? "",
    Receipt: s.receiptNum || "", Item: s.itemName, Category: s.category,
    Qty: s.quantity,
    "Unit Price (₱)": Number((s.unitPrice || 0).toFixed(2)),
    "Cost (₱)": Number((s.cost || 0).toFixed(2)),
    "Profit (₱)": Number((s.profit || 0).toFixed(2)),
    "Total (₱)": Number((s.total || 0).toFixed(2)),
    Cash: Number((s.cash || 0).toFixed(2)), Change: Number((s.change || 0).toFixed(2))
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sales");
  downloadXLSX(wb, `sales_${new Date().toISOString().slice(0,10)}.xlsx`);
  showToast("Sales exported ✅");
}
export function exportSalesToPDF() {
  if (!state.sales.length) { showToast("No sales to export ❌"); return; }
  if (!window.jspdf) { showToast("PDF library not loaded ❌"); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(16); doc.text("Sales Report", 14, 18);
  doc.setFontSize(10); doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 24);
  doc.autoTable({
    startY: 30,
    head: [["Date", "Receipt", "Item", "Qty", "Unit", "Profit", "Total"]],
    body: state.sales.map(s => [
      s.createdAt?.toDate?.().toLocaleString() ?? "-",
      s.receiptNum || "-", s.itemName, fmtInt(s.quantity),
      fmtMoney(s.unitPrice, false), fmtMoney(s.profit, false), fmtMoney(s.total, false)
    ]),
    styles: { fontSize: 8 }, headStyles: { fillColor: [18, 84, 79] }
  });
  downloadPDF(doc, `sales_${new Date().toISOString().slice(0,10)}.pdf`);
  showToast("Sales PDF exported ✅");
}
export function exportMovementsToExcel() {
  if (!state.movements.length) { showToast("No movements to export ❌"); return; }
  const data = state.movements.map(m => ({
    Date: m.createdAt?.toDate?.().toLocaleString() ?? "",
    Item: m.itemName,
    Type: m.type === "in" ? "IN (+)" : "OUT (−)",
    Quantity: m.quantity, Reason: m.reason || "", Note: m.note || ""
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Movements");
  downloadXLSX(wb, `movements_${new Date().toISOString().slice(0,10)}.xlsx`);
  showToast("Movements exported ✅");
}
export function exportHistoryToExcel() {
  const groups = groupSalesByReceipt();
  if (!groups.length) { showToast("No history to export ❌"); return; }
  const rows = [];
  groups.forEach(g => {
    g.items.forEach(it => {
      rows.push({
        Receipt: g.receiptNum, Date: g.date?.toLocaleString() || "",
        Item: it.itemName, Category: it.category || "",
        Qty: it.quantity,
        "Unit (₱)": Number((it.unitPrice || 0).toFixed(2)),
        "Total (₱)": Number((it.total || 0).toFixed(2)),
        Cashier: g.cashier || ""
      });
    });
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "SalesHistory");
  downloadXLSX(wb, `sales_history_${new Date().toISOString().slice(0,10)}.xlsx`);
  showToast("History exported ✅");
}
export function exportHistoryToPDF() {
  const groups = groupSalesByReceipt();
  if (!groups.length) { showToast("No history to export ❌"); return; }
  if (!window.jspdf) { showToast("PDF library not loaded ❌"); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(16); doc.text("Sales History", 14, 18);
  doc.setFontSize(10); doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 24);
  const body = [];
  groups.forEach(g => {
    g.items.forEach((it, idx) => {
      body.push([
        idx === 0 ? g.receiptNum : "",
        idx === 0 ? (g.date?.toLocaleString() || "") : "",
        it.itemName, fmtInt(it.quantity),
        fmtMoney(it.unitPrice, false), fmtMoney(it.total, false)
      ]);
    });
  });
  doc.autoTable({
    startY: 30, head: [["Receipt", "Date", "Item", "Qty", "Unit", "Total"]],
    body, styles: { fontSize: 8 }, headStyles: { fillColor: [18, 84, 79] }
  });
  downloadPDF(doc, `sales_history_${new Date().toISOString().slice(0,10)}.pdf`);
  showToast("History PDF exported ✅");
}

/* =========================================================
   INIT
   ========================================================= */
export function initReports() {
  const resetHistPage = () => { state.histPage = 1; };

  $("history-search")?.addEventListener("input", debounce(() => {
    resetHistPage(); renderHistory();
  }, 150));
  $("history-filter")?.addEventListener("change", () => {
    resetHistPage();
    safeRender(renderHistory);
    safeRender(renderHistoryCategorySummary);
  });
  $("history-cat-filter")?.addEventListener("change", () => {
    resetHistPage();
    safeRender(renderHistory);
    safeRender(renderHistoryCategorySummary);
  });
  $("month-filter")?.addEventListener("change", () => {
    state.soSelectedMonth = valOf($("month-filter"));
    safeRender(renderSalesOverview);
  });
  $("sales-cat-analytics-filter")?.addEventListener("change", () => {
    safeRender(renderCharts);
  });
  $("carousel-prev")?.addEventListener("click", () => { prevSlide(); restartCarousel(); });
  $("carousel-next")?.addEventListener("click", () => { nextSlide(); restartCarousel(); });
  $("export-inv-excel")?.addEventListener("click", exportInventoryToExcel);
  $("export-inv-pdf")?.addEventListener("click", exportInventoryToPDF);
  $("export-sales-excel")?.addEventListener("click", exportSalesToExcel);
  $("export-sales-pdf")?.addEventListener("click", exportSalesToPDF);
  $("export-movements")?.addEventListener("click", exportMovementsToExcel);
  $("export-history-excel")?.addEventListener("click", exportHistoryToExcel);
  $("export-history-pdf")?.addEventListener("click", exportHistoryToPDF);

  wireHistoryBulkUI();
  updateHistoryBulkUI();
}