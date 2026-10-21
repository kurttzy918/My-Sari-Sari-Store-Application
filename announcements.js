/* announcements.js — Feature announcements broadcast by super admin */
import { state, isSuperAdmin } from "./state.js";
import { $, safeRender, showToast } from "./utils.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc,
  onSnapshot, query, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { db } from "./firebase.js";

const DEBUG = true;
const log = (...a) => DEBUG && console.log("[announcements]", ...a);

/* ---------------- local storage helpers ---------------- */
const LS_KEY = "kurtpos_seen_announcements";
const LS_DISMISSED = "kurtpos_dismissed_announcements";

function getSeenIds() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch { return []; }
}
function markSeen(id) {
  const seen = getSeenIds();
  if (!seen.includes(id)) {
    seen.push(id);
    try { localStorage.setItem(LS_KEY, JSON.stringify(seen.slice(-200))); } catch {}
  }
}
function getDismissedIds() {
  try { return JSON.parse(localStorage.getItem(LS_DISMISSED) || "[]"); }
  catch { return []; }
}
function markDismissed(id) {
  const d = getDismissedIds();
  if (!d.includes(id)) {
    d.push(id);
    try { localStorage.setItem(LS_DISMISSED, JSON.stringify(d.slice(-200))); } catch {}
  }
}

/* ---------------- pending queue ---------------- */
let _pendingPopupQueue = [];
let _popupShowing = false;
let _retryTimer = null;

function isAppReadyForPopup() {
  const shell = document.getElementById("app-shell");
  const shellReady = !!shell && !shell.classList.contains("hidden");

  const terms = document.getElementById("terms-modal");
  const termsClosed = !terms || terms.classList.contains("hidden");

  const pending = document.getElementById("pending-screen");
  const pendingHidden = !pending || pending.classList.contains("hidden");

  const auth = document.getElementById("auth-screen");
  const authHidden = !auth || auth.classList.contains("hidden");

  const blockingModal = document.querySelector(
    "#install-modal:not(.hidden), #restock-modal:not(.hidden), #receipt-modal:not(.hidden), #scanner-modal:not(.hidden), #payment-modal:not(.hidden)"
  );

  const announcementModal = document.getElementById("announcement-modal");
  const announcementClosed = !announcementModal || announcementModal.classList.contains("hidden");

  const ready = shellReady && termsClosed && pendingHidden && authHidden && !blockingModal && announcementClosed;

  log("isAppReadyForPopup:", {
    shellReady, termsClosed, pendingHidden, authHidden,
    blockingModal: !!blockingModal, announcementClosed, ready
  });

  return ready;
}

export function flushPendingAnnouncements() {
  log("flushPendingAnnouncements called. Queue size:", _pendingPopupQueue.length,
      "| _popupShowing:", _popupShowing);

  // Always rescan from live data
  rescanUnread();
  log("after rescan, queue size:", _pendingPopupQueue.length);

  if (!_pendingPopupQueue.length) {
    log("no pending popups to show");
    return;
  }

  if (_popupShowing) {
    log("popup already showing, skipping");
    return;
  }

  if (!isAppReadyForPopup()) {
    log("app not ready — retrying in 1200ms");
    clearTimeout(_retryTimer);
    _retryTimer = setTimeout(flushPendingAnnouncements, 1200);
    return;
  }

  const next = _pendingPopupQueue.shift();
  if (!next) return;

  log("showing popup for:", next.id, next.title);
  _popupShowing = true;
  openAnnouncementPopup(next);
}

function rescanUnread() {
  if (!Array.isArray(state.announcements)) {
    log("rescanUnread: state.announcements not ready yet");
    return;
  }
  if (isSuperAdmin()) {
    log("rescanUnread: super admin, skipping");
    return;
  }

  const seen = getSeenIds();
  const dismissed = getDismissedIds();
  const now = Date.now();
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

  let added = 0;
  state.announcements.forEach(a => {
    if (a.active === false) return;
    if (seen.includes(a.id)) return;
    if (dismissed.includes(a.id)) return;
    if (_pendingPopupQueue.some(x => x.id === a.id)) return;

    const age = now - (a.createdAt?.toMillis?.() || 0);
    if (age > THIRTY_DAYS) {
      markSeen(a.id);
      return;
    }

    _pendingPopupQueue.push(a);
    added++;
    log("queued unread announcement:", a.id, a.title);
  });
  log(`rescanUnread: added ${added}, total queue ${_pendingPopupQueue.length}`);

  _pendingPopupQueue.sort((a, b) => {
    const ta = a.createdAt?.toMillis?.() || 0;
    const tb = b.createdAt?.toMillis?.() || 0;
    return tb - ta;
  });
}

/* ---------------- init ---------------- */
export function initAnnouncements() {
  wireAnnouncementModal();
  wireAdminAnnouncementForm();
}

/* ---------------- listeners ---------------- */
export function startAnnouncementsListener() {
  if (state.unsubscribers.announcements) {
    log("announcements listener already running");
    return;
  }

  log("starting announcements listener");

  const q = query(
    collection(db, "announcements"),
    orderBy("createdAt", "desc"),
    limit(50)
  );

  state.unsubscribers.announcements = onSnapshot(q, (snap) => {
    const previousIds = new Set((state.announcements || []).map(a => a.id));
    state.announcements = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    log("snapshot received. count:", state.announcements.length);

    renderAnnouncementBell();

    if (!isSuperAdmin()) {
      // Detect fresh live posts
      const fresh = state.announcements.filter(a =>
        a.active !== false &&
        !previousIds.has(a.id) &&
        !getSeenIds().includes(a.id) &&
        !getDismissedIds().includes(a.id)
      );
      if (fresh.length) {
        log("detected fresh announcements live:", fresh.map(x => x.id));
      }
      fresh.forEach(a => {
        if (!_pendingPopupQueue.some(x => x.id === a.id)) {
          _pendingPopupQueue.push(a);
        }
      });
    }

    // ALWAYS try to flush after data arrives
    // Use a small delay so the app-shell has time to render
    setTimeout(() => flushPendingAnnouncements(), 900);

    safeRender(renderAdminAnnouncements);
  }, (err) => {
    console.warn("[announcements] listener error:", err.code, err.message);
  });
}

/* ---------------- topbar bell ---------------- */
function renderAnnouncementBell() {
  const badge = document.getElementById("announcement-badge");
  const btn = document.getElementById("announcement-bell-btn");
  if (!btn) return;

  const unread = (state.announcements || []).filter(a =>
    a.active !== false && !getSeenIds().includes(a.id)
  );

  if (badge) {
    if (unread.length > 0) {
      badge.textContent = unread.length > 9 ? "9+" : String(unread.length);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }
  btn.title = unread.length
    ? `${unread.length} new announcement${unread.length > 1 ? "s" : ""}`
    : "Announcements";
}

/* ---------------- popup ---------------- */
let _currentPopupId = null;

function openAnnouncementPopup(announcement) {
  const modal = $("announcement-modal");
  if (!modal) {
    log("ERROR: #announcement-modal not found in DOM!");
    _popupShowing = false;
    return;
  }

  log("OPENING POPUP:", announcement.id, announcement.title);
  _currentPopupId = announcement.id;

  $("announcement-title").textContent = announcement.title || "What's New";
  $("announcement-body").innerHTML = formatAnnouncementBody(announcement.body || "");

  const authorEl = $("announcement-author");
  if (authorEl) {
    const author = announcement.authorEmail || "Kurt POS";
    const date = announcement.createdAt?.toDate?.() || new Date();
    authorEl.textContent = `${author} · ${date.toLocaleDateString()}`;
  }

  const versionEl = $("announcement-version");
  if (versionEl) {
    versionEl.textContent = announcement.version ? `v${announcement.version}` : "";
    versionEl.classList.toggle("hidden", !announcement.version);
  }

  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  markSeen(announcement.id);
  renderAnnouncementBell();
}

function formatAnnouncementBody(text) {
  const esc = (s) => String(s).replace(/[<>&]/g, c => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;"
  }[c]));

  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^- (.+)$/gm, "• $1")
    .replace(/\n/g, "<br>");
}

/* ---------------- modal wiring ---------------- */
function wireAnnouncementModal() {
  const onClose = () => {
    log("closing popup");
    _popupShowing = false;
    closeAnnouncementPopup();

    // If more queued, show next after delay
    if (_pendingPopupQueue.length) {
      setTimeout(flushPendingAnnouncements, 1500);
    }
  };

  document.getElementById("announcement-close")?.addEventListener("click", onClose);

  document.getElementById("announcement-dismiss")?.addEventListener("click", () => {
    if (_currentPopupId) markDismissed(_currentPopupId);
    onClose();
  });

  document.getElementById("announcement-view-all")?.addEventListener("click", () => {
    onClose();
    document.querySelector('.nav-btn[data-page="page-dashboard"]')?.click();
    showAnnouncementsList();
  });

  document.getElementById("announcement-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "announcement-modal") onClose();
  });

  document.getElementById("announcement-bell-btn")?.addEventListener("click", () => {
    showAnnouncementsList();
  });
}

function closeAnnouncementPopup() {
  $("announcement-modal")?.classList.add("hidden");
  const stillOpen = document.querySelector(
    ".modal:not(.hidden), .install-modal:not(.hidden), .scanner-modal:not(.hidden)"
  );
  if (!stillOpen) document.body.style.overflow = "";
  _popupShowing = false;
}

/* ---------------- "All announcements" list view ---------------- */
function showAnnouncementsList() {
  const modal = $("announcements-list-modal");
  if (!modal) return;

  const listEl = $("announcements-list-body");
  const items = state.announcements || [];

  if (!items.length) {
    listEl.innerHTML = `<div class="empty-state"><p>📭 No announcements yet.</p></div>`;
  } else {
    listEl.innerHTML = items.map(a => {
      const seen = getSeenIds().includes(a.id);
      const date = a.createdAt?.toDate?.() || null;
      return `
        <div class="announcement-list-item ${seen ? "read" : "unread"}">
          <div class="announcement-list-head">
            <strong>${escHtml(a.title || "Untitled")}</strong>
            ${a.version ? `<span class="ann-version">v${escHtml(a.version)}</span>` : ""}
            ${!seen ? `<span class="ann-unread-dot" title="New"></span>` : ""}
          </div>
          <div class="announcement-list-body">${formatAnnouncementBody(a.body || "")}</div>
          <div class="announcement-list-meta">
            ${date ? date.toLocaleString() : ""}
          </div>
        </div>`;
    }).join("");
    items.forEach(a => markSeen(a.id));
    renderAnnouncementBell();
  }

  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";

  const closeBtn = document.getElementById("announcements-list-close");
  if (closeBtn) {
    const handler = () => {
      modal.classList.add("hidden");
      document.body.style.overflow = "";
      closeBtn.removeEventListener("click", handler);
    };
    closeBtn.addEventListener("click", handler);
  }
}

/* ---------------- Admin: create / edit / delete ---------------- */
function wireAdminAnnouncementForm() {
  const form = $("announcement-form");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!isSuperAdmin()) { showToast("Only super admin can post ❌"); return; }

    const id = $("announcement-id").value.trim();
    const title = $("announcement-form-title").value.trim();
    const version = $("announcement-form-version").value.trim();
    const body = $("announcement-form-body").value.trim();
    const active = $("announcement-form-active").checked;

    if (!title || !body) { showToast("Title and body are required"); return; }

    const payload = {
      title,
      version: version || "",
      body,
      active,
      authorEmail: state.currentUser?.email || "",
      authorUid: state.currentUser?.uid || "",
      updatedAt: serverTimestamp()
    };

    try {
      if (id) {
        await updateDoc(doc(db, "announcements", id), payload);
        showToast("Announcement updated ✅");
      } else {
        payload.createdAt = serverTimestamp();
        await addDoc(collection(db, "announcements"), payload);
        showToast("Announcement posted — users will see it 🎉");
      }
      resetAnnouncementForm();
      safeRender(renderAdminAnnouncements);
    } catch (err) {
      console.error("[announcements] save failed:", err);
      if (err.code === "permission-denied") {
        showToast("Permission denied — check Firestore rules ❌");
      } else {
        showToast(`Save failed: ${err.code || err.message} ❌`);
      }
    }
  });

  $("announcement-reset-btn")?.addEventListener("click", resetAnnouncementForm);
}

function resetAnnouncementForm() {
  const form = $("announcement-form");
  if (!form) return;
  form.reset();
  $("announcement-id").value = "";
  $("announcement-form-active").checked = true;
  const titleEl = $("announcement-form-title-label");
  if (titleEl) titleEl.textContent = "✍️ New Announcement";
  const submitBtn = $("announcement-submit-btn");
  if (submitBtn) submitBtn.textContent = "📤 Post Announcement";
}

export function renderAdminAnnouncements() {
  const list = $("admin-announcements-list");
  if (!list) return;

  if (!isSuperAdmin()) {
    list.innerHTML = `<div class="empty-state"><p>🔒 Only super admin can manage announcements.</p></div>`;
    return;
  }

  const items = state.announcements || [];
  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><p>📭 No announcements yet. Create one above.</p></div>`;
    return;
  }

  list.innerHTML = items.map(a => {
    const date = a.createdAt?.toDate?.();
    return `
      <div class="announcement-admin-item ${a.active === false ? "inactive" : ""}">
        <div class="ann-item-head">
          <div>
            <strong>${escHtml(a.title || "Untitled")}</strong>
            ${a.version ? `<span class="ann-version">v${escHtml(a.version)}</span>` : ""}
            ${a.active === false ? `<span class="ann-badge-off">Hidden</span>` : `<span class="ann-badge-on">Live</span>`}
          </div>
          <div class="ann-item-date">${date ? date.toLocaleString() : "—"}</div>
        </div>
        <div class="ann-item-body">${formatAnnouncementBody(a.body || "")}</div>
        <div class="ann-item-actions">
          <button type="button" class="btn ghost sm" onclick="editAnnouncement('${a.id}')">✏️ Edit</button>
          <button type="button" class="btn ghost sm" onclick="toggleAnnouncementActive('${a.id}')">
            ${a.active === false ? "👁️ Show" : "🙈 Hide"}
          </button>
          <button type="button" class="btn danger sm" onclick="deleteAnnouncement('${a.id}')">🗑️ Delete</button>
        </div>
      </div>`;
  }).join("");
}

/* ---------------- global handlers ---------------- */
window.editAnnouncement = (id) => {
  if (!isSuperAdmin()) return;
  const a = (state.announcements || []).find(x => x.id === id);
  if (!a) return;
  $("announcement-id").value = a.id;
  $("announcement-form-title").value = a.title || "";
  $("announcement-form-version").value = a.version || "";
  $("announcement-form-body").value = a.body || "";
  $("announcement-form-active").checked = a.active !== false;
  const lbl = $("announcement-form-title-label");
  if (lbl) lbl.textContent = "✏️ Edit Announcement";
  const submitBtn = $("announcement-submit-btn");
  if (submitBtn) submitBtn.textContent = "💾 Update Announcement";
  $("announcement-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
};

window.toggleAnnouncementActive = async (id) => {
  if (!isSuperAdmin()) return;
  const a = (state.announcements || []).find(x => x.id === id);
  if (!a) return;
  try {
    await updateDoc(doc(db, "announcements", id), {
      active: a.active === false,
      updatedAt: serverTimestamp()
    });
    showToast(a.active === false ? "Announcement is now live 👁️" : "Announcement hidden 🙈");
  } catch (err) { showToast(`Failed: ${err.code || err.message} ❌`); }
};

window.deleteAnnouncement = async (id) => {
  if (!isSuperAdmin()) return;
  if (!confirm("Delete this announcement? Users won't see it anymore.")) return;
  try {
    await deleteDoc(doc(db, "announcements", id));
    showToast("Announcement deleted 🗑️");
  } catch (err) { showToast(`Failed: ${err.code || err.message} ❌`); }
};

/* ---------------- debug helper ---------------- */
window.debugAnnouncements = () => {
  console.log("[announcements] DEBUG DUMP");
  console.log("  state.announcements:", state.announcements);
  console.log("  pending queue:", _pendingPopupQueue);
  console.log("  _popupShowing:", _popupShowing);
  console.log("  seen ids:", getSeenIds());
  console.log("  dismissed ids:", getDismissedIds());
  console.log("  isSuperAdmin:", isSuperAdmin());
  console.log("  isAppReadyForPopup:", isAppReadyForPopup());
  flushPendingAnnouncements();
};

function escHtml(s) {
  return String(s ?? "").replace(/[<>&"']/g, c => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;"
  }[c]));
}