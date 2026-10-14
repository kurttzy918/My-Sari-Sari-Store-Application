/* staff.js — Owner/Admin manages staff of their workspace */
import {
  collection, addDoc, onSnapshot, query, where, doc,
  updateDoc, serverTimestamp, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { state, isManager, isOwner, ROLES } from "./state.js";
import { $, valOf, esc, safeRender, showToast, myWorkspace } from "./utils.js";

/* =========================================================
   HELPERS
   ========================================================= */
function genInviteCode() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function roleLabel(role) {
  return (role || "staff").charAt(0).toUpperCase() + (role || "staff").slice(1);
}

/* =========================================================
   SEND INVITE
   ========================================================= */
async function sendInvite() {
  if (!isManager()) { showToast("Only owners/admins can invite ❌"); return; }

  const email = valOf($("invite-email")).trim().toLowerCase();
  const role  = valOf($("invite-role")) || ROLES.CASHIER;
  const errEl = $("invite-error");
  const resEl = $("invite-result");
  const btn   = $("invite-send-btn");

  if (errEl) errEl.textContent = "";
  if (resEl) resEl.classList.add("hidden");

  if (!email) { if (errEl) errEl.textContent = "Enter an email."; return; }
  if (!["cashier", "admin"].includes(role)) {
    if (errEl) errEl.textContent = "Pick a valid role.";
    return;
  }

  const wsId = myWorkspace();
  if (!wsId) { if (errEl) errEl.textContent = "No workspace found."; return; }

  const code = genInviteCode();
  if (btn) btn.disabled = true;

  try {
    await addDoc(collection(db, "workspace_invites"), {
      workspaceId: wsId,
      workspaceName: state.currentWorkspace?.name || "My Store",
      email,
      role,
      invitedBy: state.currentUser?.uid,
      invitedByName:
        state.currentUserData?.displayName ||
        state.currentUser?.email || "",
      status: "pending",
      code,
      createdAt: serverTimestamp(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    if (resEl) {
      resEl.classList.remove("hidden");
      resEl.innerHTML = `
        ✅ Invite created for <strong>${esc(email)}</strong>.<br>
        Share this code: <code class="invite-code">${code}</code><br>
        <small>They sign up with this email, then paste the code.</small>`;
    }
    showToast("Invite created ✅");
  } catch (err) {
    console.error("[invite]", err);
    if (errEl) errEl.textContent = `Failed: ${err.code || err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* =========================================================
   RENDER — Staff list
   ========================================================= */
function renderStaffList() {
  const list = $("staff-list");
  if (!list) return;

  if (!state.workspaceStaff) {
    list.innerHTML = `<div class="empty-state"><p>⏳ Loading staff…</p></div>`;
    return;
  }

  if (!state.workspaceStaff.length) {
    list.innerHTML = `<div class="empty-state"><p>No staff yet — invite someone!</p></div>`;
    return;
  }

  const ownerUid = state.currentWorkspace?.ownerUid;
  const currentUid = state.currentUser?.uid;

  list.innerHTML = state.workspaceStaff.map(u => {
    const role = u.role || "staff";
    const isOwnerRow = role === "owner" || u.id === ownerUid;
    const isSelf = u.id === currentUid;
    const canRemove = isManager() && !isOwnerRow && !isSelf;

    // Workspace owner gets a special badge
    const ownerBadge = (u.id === ownerUid)
      ? `<span class="role-badge owner" title="Workspace owner">👑 OWNER</span>`
      : "";

    return `
      <div class="user-row ${isOwnerRow ? "is-owner-row" : ""}">
        <div class="user-info">
          <div class="user-mail">
            ${esc(u.email || "")}
            ${ownerBadge}
            <span class="role-badge ${esc(role)}">${esc(roleLabel(role).toUpperCase())}</span>
            ${isSelf ? `<span class="self-tag">(you)</span>` : ""}
          </div>
          <div class="user-meta">
            ${u.approved ? "✅ Approved" : "⏳ Pending"} ·
            Joined ${u.createdAt?.toDate?.().toLocaleDateString() || "—"}
          </div>
        </div>
        <div class="user-actions">
          ${canRemove
            ? `<button type="button" class="btn danger" onclick="removeStaff('${u.id}')">Remove</button>`
            : isOwnerRow
              ? `<span class="owner-protect" title="Workspace owner cannot be removed">🔒 Protected</span>`
              : ""}
        </div>
      </div>`;
  }).join("");
}

/* =========================================================
   RENDER — Pending invites
   ========================================================= */
function renderInvitesList() {
  const list = $("invites-list");
  if (!list) return;

  if (!state.workspaceInvites) {
    list.innerHTML = `<div class="empty-state"><p>⏳ Loading invites…</p></div>`;
    return;
  }

  if (!state.workspaceInvites.length) {
    list.innerHTML = `<div class="empty-state"><p>No pending invites.</p></div>`;
    return;
  }

  list.innerHTML = state.workspaceInvites.map(inv => `
    <div class="user-row">
      <div class="user-info">
        <div class="user-mail">
          ${esc(inv.email || "")}
          <span class="role-badge ${esc(inv.role || "cashier")}">${esc(roleLabel(inv.role).toUpperCase())}</span>
        </div>
        <div class="user-meta">
          Code: <code class="invite-code-sm">${esc(inv.code || "")}</code> ·
          Created ${inv.createdAt?.toDate?.().toLocaleDateString() || "—"}
        </div>
      </div>
      <div class="user-actions">
        <button type="button" class="btn ghost" onclick="revokeInvite('${inv.id}')">Revoke</button>
      </div>
    </div>
  `).join("");
}

/* =========================================================
   REMOVE STAFF
   ========================================================= */
window.removeStaff = async (uid) => {
  if (!isManager()) return;
  if (!confirm("Remove this staff member from your workspace?")) return;
  try {
    await updateDoc(doc(db, "users", uid), {
      workspaceId: null,
      role: null,
      approved: false,
      accountStatus: "pending"
    });

    // Decrement staffCount
    const wsId = myWorkspace();
    if (wsId) {
      try {
        const wsRef = doc(db, "workspaces", wsId);
        const wsSnap = await getDoc(wsRef);
        if (wsSnap.exists()) {
          const cur = Number(wsSnap.data().staffCount) || 0;
          await updateDoc(wsRef, { staffCount: Math.max(0, cur - 1) });
        }
      } catch (e) { console.warn("[staffCount]", e); }
    }

    showToast("Staff removed ✅");
  } catch (err) {
    showToast(`Failed: ${err.code || err.message} ❌`);
  }
};

/* =========================================================
   REVOKE INVITE
   ========================================================= */
window.revokeInvite = async (inviteId) => {
  if (!isManager()) return;
  if (!confirm("Revoke this invite?")) return;
  try {
    await updateDoc(doc(db, "workspace_invites", inviteId), {
      status: "revoked",
      revokedAt: serverTimestamp(),
      revokedBy: state.currentUser?.uid || null
    });
    showToast("Invite revoked 🗑️");
  } catch (err) {
    showToast(`Failed: ${err.code || err.message} ❌`);
  }
};

/* =========================================================
   RENDER PAGE
   ========================================================= */
export function renderStaffPage() {
  // Super admin has their own admin panel — hide staff management
  if (state.currentUserData?.role === "superadmin") {
    const gate = $("staff-role-gate");
    if (gate) gate.classList.remove("hidden");
    const body = $("staff-body");
    if (body) body.classList.add("hidden");
    return;
  }

  renderStaffList();
  renderInvitesList();

  // Show a note for cashiers (they shouldn't reach here, but just in case)
  const gate = $("staff-role-gate");
  if (gate) gate.classList.toggle("hidden", isManager());
  const body = $("staff-body");
  if (body) body.classList.toggle("hidden", !isManager());
}

/* =========================================================
   INIT
   ========================================================= */
export function initStaff() {
  $("invite-staff-btn")?.addEventListener("click", () => {
    const modal = $("invite-modal");
    if (!modal) return;
    $("invite-error") && ($("invite-error").textContent = "");
    $("invite-result")?.classList.add("hidden");
    if ($("invite-email")) $("invite-email").value = "";
    if ($("invite-role"))  $("invite-role").value = ROLES.CASHIER;
    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
  });

  $("invite-send-btn")?.addEventListener("click", sendInvite);

  $("invite-copy-btn")?.addEventListener("click", () => {
    const codeEl = $("invite-result")?.querySelector(".invite-code");
    if (!codeEl) return;
    const code = codeEl.textContent.trim();
    navigator.clipboard?.writeText(code)
      .then(() => showToast("Code copied 📋"))
      .catch(() => showToast("Copy failed ❌"));
  });
}

/* =========================================================
   LISTENERS
   ========================================================= */
export function startStaffListeners() {
  const wsId = myWorkspace();
  if (!wsId) return;

  // Staff (all users with the same workspaceId)
  if (state.unsubscribers.workspaceStaff) {
    try { state.unsubscribers.workspaceStaff(); } catch {}
  }
  state.unsubscribers.workspaceStaff = onSnapshot(
    query(collection(db, "users"), where("workspaceId", "==", wsId)),
    (snap) => {
      state.workspaceStaff = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => {
          const ra = a.role === "owner" ? 0 : a.role === "admin" ? 1 : 2;
          const rb = b.role === "owner" ? 0 : b.role === "admin" ? 1 : 2;
          if (ra !== rb) return ra - rb;
          return (a.email || "").localeCompare(b.email || "");
        });
      safeRender(renderStaffList);
    },
    (err) => console.error("[Staff listener]", err.code, err.message)
  );

  // Pending invites
  if (state.unsubscribers.workspaceInvites) {
    try { state.unsubscribers.workspaceInvites(); } catch {}
  }
  state.unsubscribers.workspaceInvites = onSnapshot(
    query(
      collection(db, "workspace_invites"),
      where("workspaceId", "==", wsId),
      where("status", "==", "pending")
    ),
    (snap) => {
      state.workspaceInvites = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      safeRender(renderInvitesList);
    },
    (err) => console.error("[Invites listener]", err.code, err.message)
  );
}