/* terms.js — Terms & Conditions gate + viewer */

import {
  doc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { state } from "./state.js";
import { $, showToast } from "./utils.js";

/* =========================================================
   CONFIG — bump the version to force re-acceptance
   ========================================================= */
export const TERMS_VERSION = "1.0.0";
const TERMS_UPDATED = "October 2025";

/* =========================================================
   TERMS CONTENT
   ========================================================= */
const TERMS_SECTIONS = [
  {
    title: "1. Purpose of the App",
    body: `Kurt Inventory · Smart Stock & Sales ("the App") is a business management tool built for sari-sari stores and small retail businesses. It helps you track inventory, run a point-of-sale, manage customer utang, record e-wallet transactions (GCash, Maya), sell prepaid load, and view reports.`
  },
  {
    title: "2. Smooth Business Flow Only",
    body: `The App is designed and provided <strong>solely to help streamline your daily business operations</strong>. It is not a bank, payment processor, or financial advisor, and it does not hold, transfer, or process real money on your behalf. All monetary figures shown — balances, profits, wallet totals — are records you enter yourself for your own bookkeeping.`
  },
  {
    title: "3. Your Account & Workspace",
    body: `Your account is tied to a private workspace. Every store has its own isolated data — nothing is shared with other stores. You are responsible for keeping your login credentials safe. Only approved accounts can access the App.`
  },
  {
    title: "4. Your Data",
    body: `All data you enter — inventory, sales, customer records, e-wallet transactions, load sales — belongs to you. It is stored securely in Google Firebase. We do not sell, share, or analyze your business data for third parties. You can export or delete your data at any time from the App itself.`
  },
  {
    title: "5. Acceptable Use",
    body: `Use the App only for lawful business purposes. Do not attempt to bypass security, impersonate other users, reverse-engineer the App, or use it to store illegal content or facilitate unlawful transactions.`
  },
  {
    title: "6. Accuracy of Records",
    body: `You are responsible for the accuracy of the information you enter. The App performs automatic calculations (profits, wallet balances, change, cost), but you should always verify critical entries — especially financial records and customer utang balances — before acting on them.`
  },
  {
    title: "7. Third-Party Services",
    body: `The App uses <strong>Google Firebase</strong> for authentication and data storage. Charts, barcode scanning, QR codes, and PDF export rely on open-source libraries (Chart.js, JsBarcode, html5-qrcode, qrcode, SheetJS, jsPDF). These services have their own terms of use.`
  },
  {
    title: "8. Availability",
    body: `The App is provided as-is. While we aim for high availability, we cannot guarantee 100% uptime. Offline mode is supported — changes you make while offline sync automatically when you reconnect.`
  },
  {
    title: "9. No Warranty",
    body: `The App is provided "as is" without warranty of any kind. We are not liable for business losses, missed sales, data loss, or damages arising from its use.`
  },
  {
    title: "10. Changes to These Terms",
    body: `We may update these Terms occasionally. When we do, you'll be asked to review and accept the new version on your next login.`
  },
  {
    title: "11. Contact",
    body: `Questions, concerns, or feedback? Reach out to the developer (Kurt POS) through the contact details on the App's social links.`
  }
];

/* =========================================================
   STATE
   ========================================================= */
let _gateMode = false;     // true = blocking (must accept/decline)
let _onAccept = null;
let _onDecline = null;

/* =========================================================
   RENDER TERMS CONTENT
   ========================================================= */
function renderTermsContent() {
  const el = $("terms-content");
  if (!el) return;

  el.innerHTML = `
    <p class="terms-intro">
      Welcome to <strong>Kurt Inventory · Smart Stock &amp; Sales</strong>.
      Please read these Terms carefully. By continuing to use the App, you agree to them.
    </p>
    ${TERMS_SECTIONS.map(s => `
      <section class="terms-section">
        <h4 class="terms-section-title">${s.title}</h4>
        <p class="terms-section-body">${s.body}</p>
      </section>
    `).join("")}
    <p class="terms-footer">
      Thank you for using the App. Wishing you smooth business flow. 🙏
    </p>
  `;

  const vEl = $("terms-version"); if (vEl) vEl.textContent = TERMS_VERSION;
  const uEl = $("terms-updated"); if (uEl) uEl.textContent = `Updated ${TERMS_UPDATED}`;
}

/* =========================================================
   SCROLL TO BOTTOM → ENABLE "I AGREE"
   ========================================================= */
function wireScrollGate() {
  const content = $("terms-content");
  const acceptBtn = $("terms-accept");
  const fade = $("terms-fade");
  if (!content || !acceptBtn) return;

  // If content is short enough to fit without scrolling, enable immediately
  const check = () => {
    const atBottom =
      content.scrollHeight - content.scrollTop - content.clientHeight < 24;
    if (atBottom) {
      acceptBtn.disabled = false;
      fade?.classList.add("hidden");
    } else {
      acceptBtn.disabled = true;
      fade?.classList.remove("hidden");
    }
  };

  // Detach previous listeners by cloning is overkill — just re-run check
  content.addEventListener("scroll", check, { passive: true });
  window.addEventListener("resize", check);

  // Initial
  requestAnimationFrame(check);

  // Also make the fade clickable so users can jump to the bottom
  fade?.addEventListener("click", () => {
    content.scrollTo({ top: content.scrollHeight, behavior: "smooth" });
  });
}

/* =========================================================
   OPEN — as a BLOCKING gate (first login)
   ========================================================= */
export function showTermsGate({ onAccept, onDecline } = {}) {
  _gateMode = true;
  _onAccept = onAccept || null;
  _onDecline = onDecline || null;

  // Hide close button — user must choose
  $("terms-close")?.classList.add("hidden");

  // Change decline label to make consequence clear
  const declineBtn = $("terms-decline");
  if (declineBtn) declineBtn.textContent = "Decline & Sign Out";

  renderTermsContent();
  wireScrollGate();

  const modal = $("terms-modal");
  modal?.classList.remove("hidden");
  document.body.style.overflow = "hidden";

  // Scroll content to top each time
  const content = $("terms-content");
  if (content) content.scrollTop = 0;
}

/* =========================================================
   OPEN — as a VIEWER (review at any time)
   ========================================================= */
export function showTermsViewer() {
  _gateMode = false;
  _onAccept = null;
  _onDecline = null;

  // Show the close button
  $("terms-close")?.classList.remove("hidden");

  // Neutral decline label
  const declineBtn = $("terms-decline");
  if (declineBtn) declineBtn.textContent = "Close";

  // Accept button not needed in viewer mode — hide it
  const acceptBtn = $("terms-accept");
  if (acceptBtn) acceptBtn.classList.add("hidden");

  renderTermsContent();
  wireScrollGate();

  const modal = $("terms-modal");
  modal?.classList.remove("hidden");
  document.body.style.overflow = "hidden";

  const content = $("terms-content");
  if (content) content.scrollTop = 0;
}

/* =========================================================
   CLOSE
   ========================================================= */
function closeTermsModal() {
  $("terms-modal")?.classList.add("hidden");
  _gateMode = false;

  // Restore buttons for the next open
  $("terms-accept")?.classList.remove("hidden");
  $("terms-decline") && ($("terms-decline").textContent = "Decline");
  document.body.style.overflow = "";
}

/* =========================================================
   WIRE
   ========================================================= */
let _wired = false;

export function wireTerms() {
  if (_wired) return;
  _wired = true;

  // Close button (viewer mode only)
  $("terms-close")?.addEventListener("click", closeTermsModal);

  // Backdrop click — only closes in viewer mode
  $("terms-modal")?.addEventListener("click", (e) => {
    if (e.target === $("terms-modal") && !_gateMode) closeTermsModal();
  });

  // Escape key — only closes in viewer mode
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !_gateMode) closeTermsModal();
  });

  // Decline / Close button
  $("terms-decline")?.addEventListener("click", async () => {
    if (_gateMode) {
      // Blocking gate → run decline callback (usually signs the user out)
      try { _onDecline?.(); }
      catch (err) { console.error("[terms] decline error:", err); }
    } else {
      closeTermsModal();
    }
  });

    // Accept button
  $("terms-accept")?.addEventListener("click", async () => {
    if (!_gateMode) return;

    const btn = $("terms-accept");
    const originalText = btn?.textContent || "I Agree";

    // Show loading state while the acceptance is being saved
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Saving…";
    }

    try {
      if (_onAccept) await _onAccept();
      // Close the modal AFTER the callback completes successfully
      closeTermsModal();
    } catch (err) {
      console.error("[terms] accept failed:", err);
      showToast("Couldn't save acceptance — try again ❌");
      // Restore the button so the user can retry
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  });

  // Sidebar link → open as viewer
  document.getElementById("nav-terms")?.addEventListener("click", () => {
    showTermsViewer();
  });
}

/* =========================================================
   ACCEPTANCE PERSISTENCE
   ========================================================= */
export function hasAcceptedTerms(userData) {
  if (!userData) return false;
  return (
    userData.termsAcceptedVersion === TERMS_VERSION &&
    !!userData.termsAcceptedAt
  );
}

export async function recordTermsAcceptance() {
  const uid = state.currentUser?.uid;
  if (!uid) return;

  // ── Optimistic local update FIRST ──
  // This ensures the gate won't re-open even if the network / rules block the write.
  if (state.currentUserData) {
    state.currentUserData.termsAcceptedVersion = TERMS_VERSION;
    state.currentUserData.termsAcceptedAt = new Date();
  }

  // ── Persist to Firestore ──
  try {
    await updateDoc(doc(db, "users", uid), {
      termsAcceptedVersion: TERMS_VERSION,
      termsAcceptedAt: serverTimestamp()
    });
    showToast("Terms accepted ✅");
  } catch (err) {
    // Don't throw — the user is already unblocked locally.
    console.warn("[terms] Firestore write failed:", err.code || err.message);
    showToast("Terms accepted (offline) ✅");
  }
}
/* =========================================================
   SESSION-BASED ACCEPTANCE
   -------------------------------------------------
   Regular users must re-accept on every fresh tab session.
   A page refresh within the same tab will NOT re-show the gate.
   ========================================================= */
const SESSION_KEY = (uid) => `termsAcceptedSession:${uid}`;

export function markSessionAccepted(uid) {
  if (!uid) return;
  try { sessionStorage.setItem(SESSION_KEY(uid), TERMS_VERSION); } catch {}
}

export function hasSessionAccepted(uid) {
  if (!uid) return false;
  try {
    return sessionStorage.getItem(SESSION_KEY(uid)) === TERMS_VERSION;
  } catch { return false; }
}

export function clearSessionAccepted(uid) {
  if (!uid) return;
  try { sessionStorage.removeItem(SESSION_KEY(uid)); } catch {}
}