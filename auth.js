/* auth.js — Authentication + auth screen + pending screen + workspace */
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged,
  GoogleAuthProvider, signInWithPopup,
  setPersistence, browserLocalPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp, onSnapshot,
  collection, query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { state, CONSTANTS } from "./state.js";
import { $, valOf, showToast } from "./utils.js";

const { SUPER_ADMIN_EMAIL } = CONSTANTS;

/* =========================================================
   GOOGLE PROVIDER
   ========================================================= */
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({
  prompt: "select_account",
  login_hint: "",
});

/* =========================================================
   REMEMBER ME
   ========================================================= */
const REMEMBER_KEY = "rememberMe";

function getRememberMe() {
  const el = document.getElementById("remember-me");
  if (el) return !!el.checked;
  return localStorage.getItem(REMEMBER_KEY) !== "false";
}
function saveRememberMe(v) {
  try { localStorage.setItem(REMEMBER_KEY, String(!!v)); } catch {}
}
function restoreRememberMeUI() {
  const el = $("remember-me");
  if (!el) return;
  el.checked = localStorage.getItem(REMEMBER_KEY) !== "false";
}

/* =========================================================
   AUTH BACKGROUND IMAGES
   ========================================================= */
function getConfiguredAuthBgImages() {
  try {
    const raw = localStorage.getItem("authBgImages");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed.map(String).filter(Boolean);
    }
  } catch (e) { console.warn("[auth-bg] bad localStorage value:", e); }
  return CONSTANTS.DEFAULT_AUTH_BG_IMAGES.slice();
}

export function buildAuthBackground(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const urls = getConfiguredAuthBgImages();
  container.innerHTML = urls.map((url, i) => `
    <div class="auth-bg-slide ${i === 0 ? "active" : ""}">
      <img src="${url}" alt="" loading="eager"
           onerror="this.closest('.auth-bg-slide').classList.add('broken'); this.remove();" />
    </div>`).join("");
  setTimeout(() => {
    const slides = container.querySelectorAll(".auth-bg-slide");
    const working = [...slides].filter(s => !s.classList.contains("broken"));
    if (!working.length) {
      container.innerHTML = CONSTANTS.FALLBACK_AUTH_BG_IMAGES.map((url, i) => `
        <div class="auth-bg-slide ${i === 0 ? "active" : ""}">
          <img src="${url}" alt="" loading="eager" />
        </div>`).join("");
    }
  }, 2500);
}

export function startAuthBgCarousel(containerId) {
  stopAuthBgCarousel();
  const container = document.getElementById(containerId);
  if (!container) return;
  const slides = container.querySelectorAll(".auth-bg-slide");
  if (slides.length <= 1) return;
  state.authBgIndex = 0;
  state.authBgTimer = setInterval(() => {
    const cur = container.querySelectorAll(".auth-bg-slide");
    if (!cur.length) return;
    if (cur[state.authBgIndex]) cur[state.authBgIndex].classList.remove("active");
    state.authBgIndex = (state.authBgIndex + 1) % cur.length;
    if (cur[state.authBgIndex]) cur[state.authBgIndex].classList.add("active");
  }, CONSTANTS.AUTH_BG_INTERVAL_MS);
}

export function stopAuthBgCarousel() {
  if (state.authBgTimer) { clearInterval(state.authBgTimer); state.authBgTimer = null; }
}

export function startTextCarousel(containerSelector, itemSelector, intervalMs = 3000) {
  const containers = document.querySelectorAll(containerSelector);
  if (!containers.length) return;

  containers.forEach((container) => {
    const items = container.querySelectorAll(itemSelector);
    if (!items.length) return;
    if (items.length === 1) { items[0].classList.add("active"); return; }

    let idx = 0;
    items.forEach((el, i) => el.classList.toggle("active", i === 0));
    setInterval(() => {
      if (!items[idx] || !items[idx].isConnected) return;
      items[idx].classList.remove("active");
      idx = (idx + 1) % items.length;
      items[idx].classList.add("active");
    }, intervalMs);
  });
}

/* =========================================================
   AUTH MODE
   ========================================================= */
function setAuthMode(isSignup) {
  state.isSignupMode = isSignup;
  const authTabs = $("auth-tabs");
  const tabLogin = $("tab-login"), tabSignup = $("tab-signup");
  const authSubmit = $("auth-submit"), authError = $("auth-error");
  if (authTabs) authTabs.classList.toggle("signup-mode", isSignup);
  tabLogin?.classList.toggle("active", !isSignup);
  tabSignup?.classList.toggle("active", isSignup);
  if (authSubmit) authSubmit.textContent = isSignup ? "Create Account" : "Login";
  if (authError) authError.textContent = "";

  const gtxt = $("google-btn-text");
  if (gtxt) gtxt.textContent = isSignup ? "Sign up with Google" : "Continue with Google";

  const form = $("auth-form");
  if (form) { form.style.animation = "none"; void form.offsetWidth; form.style.animation = ""; }
  setTimeout(() => $("email")?.focus({ preventScroll: true }), 300);
}

/* =========================================================
   FRIENDLY ERROR MESSAGES
   ========================================================= */
function friendlyAuthError(code) {
  const host = (typeof location !== "undefined" && location.hostname) || "unknown";
  const proto = (typeof location !== "undefined" && location.protocol) || "";

  const map = {
    "auth/invalid-email": "Invalid email address.",
    "auth/user-not-found": "No account found with this email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/email-already-in-use": "This email is already registered.",
    "auth/weak-password": "Password should be at least 6 characters.",
    "auth/invalid-credential": "Invalid email or password.",
    "auth/too-many-requests": "Too many attempts. Try again later.",
    "auth/network-request-failed": "Network error. Check your connection.",
    "auth/account-exists-with-different-credential":
      "This email is already registered with a password. Sign in with email instead.",
    "auth/popup-blocked":
      "Popup blocked. Allow popups for this site, then try again.",
    "auth/popup-closed-by-user": "Sign-in was cancelled.",
    "auth/cancelled-popup-request": "Sign-in was cancelled.",
    "auth/operation-not-allowed":
      "Google sign-in is not enabled. Enable it in Firebase Console → Authentication → Sign-in method → Google.",
    "auth/unauthorized-domain":
      `Domain "${host}" isn't authorized.\n\n` +
      `Add it in Firebase Console → Authentication → Settings → Authorized domains.\n\n` +
      `Enter EXACTLY this (no https://, no trailing slash): ${host}`,
    "auth/internal-error":
      "Sign-in service had a hiccup. Try again in a moment."
  };

  if (code === "auth/unauthorized-domain" && proto === "file:") {
    return (
      "You're opening the app directly from a file (file://).\n\n" +
      "Google Sign-In requires the app to be served over http://localhost or https://.\n\n" +
      "Start a local server (e.g. `python -m http.server 5500`) and open http://localhost:5500 instead."
    );
  }

  return map[code] || `Login failed (${code || "unknown error"}).`;
}

/* =========================================================
   WORKSPACE BOOTSTRAP — IDEMPOTENT
   ---------------------------------------------------------
   Uses the user's UID as the workspace ID. This makes the
   operation fully idempotent — calling it twice yields the
   same doc (setDoc with merge). No duplicates possible.
   ========================================================= */
async function createWorkspaceForOwner(user) {
  const wsId = user.uid;
  const wsRef = doc(db, "workspaces", wsId);

  const storeName =
    (user.displayName ? `${user.displayName}'s Store` :
     (user.email || "").split("@")[0] + "'s Store") || "My Store";

  await setDoc(wsRef, {
    id: wsId,
    name: storeName,
    ownerUid: user.uid,
    ownerEmail: (user.email || "").toLowerCase(),
    plan: "free",
    staffCount: 1,                 // owner counts as the first member
    status: "active",
    createdAt: serverTimestamp(),
    createdBy: user.uid
  }, { merge: true });

  console.log("[workspace] created/updated:", wsId);
  return wsId;
}

/* =========================================================
   JOIN WORKSPACE VIA INVITE CODE
   ========================================================= */
export async function acceptWorkspaceInvite(code) {
  const uid = state.currentUser?.uid;
  if (!uid) throw new Error("Not signed in");

  const clean = String(code || "").trim().toUpperCase();
  if (!clean) throw new Error("Enter an invite code");

  const snap = await getDocs(
    query(
      collection(db, "workspace_invites"),
      where("code", "==", clean),
      where("status", "==", "pending")
    )
  );

  if (snap.empty) throw new Error("Invalid or expired invite code");

  const inviteDoc = snap.docs[0];
  const invite = inviteDoc.data();

  // Optional email-match check
  const myEmail = (state.currentUser?.email || "").toLowerCase();
  if (invite.email && invite.email !== myEmail) {
    throw new Error(`This invite was sent to ${invite.email}`);
  }

  // 1) Attach user to workspace
  await updateDoc(doc(db, "users", uid), {
    workspaceId: invite.workspaceId,
    role: invite.role || "cashier",
    approved: true,
    accountStatus: "active",
    invitedBy: invite.invitedBy || null,
    invitedAt: serverTimestamp()
  });

  // 2) Mark invite accepted
  await updateDoc(doc(db, "workspace_invites", inviteDoc.id), {
    status: "accepted",
    acceptedAt: serverTimestamp(),
    acceptedBy: uid
  });

  // 3) Bump workspace staffCount
  try {
    const wsRef = doc(db, "workspaces", invite.workspaceId);
    const wsSnap = await getDoc(wsRef);
    if (wsSnap.exists()) {
      const current = Number(wsSnap.data().staffCount) || 0;
      await updateDoc(wsRef, { staffCount: current + 1 });
    }
  } catch (e) { console.warn("[invite] staffCount bump failed:", e); }

  return invite;
}

/* =========================================================
   INIT AUTH UI
   ========================================================= */
export function initAuthUI() {
  restoreRememberMeUI();

  const tabLogin = $("tab-login"), tabSignup = $("tab-signup");
  tabLogin?.addEventListener("click", () => setAuthMode(false));
  tabSignup?.addEventListener("click", () => setAuthMode(true));

  const authForm = $("auth-form");
  const authSubmit = $("auth-submit");
  const authError = $("auth-error");

  /* ---------- Email / Password submit ---------- */
  authForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (authError) authError.textContent = "";

    const email = valOf($("email")).trim().toLowerCase();
    const password = valOf($("password"));

    if (!email || !password) {
      if (authError) authError.textContent = "Enter email and password.";
      return;
    }

    const remember = getRememberMe();
    saveRememberMe(remember);
    if (authSubmit) authSubmit.disabled = true;

    try {
      try {
        await setPersistence(
          auth,
          remember ? browserLocalPersistence : browserSessionPersistence
        );
      } catch (persistErr) {
        console.warn("[Auth] setPersistence failed:", persistErr);
      }

      if (state.isSignupMode) {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        const isSuper = email === SUPER_ADMIN_EMAIL.toLowerCase();

        let workspaceId;
        let role;

        if (isSuper) {
          workspaceId = cred.user.uid;
          role = "superadmin";
        } else {
          // New signup = new store owner → create their workspace
          workspaceId = await createWorkspaceForOwner(cred.user);
          role = "owner";
        }

        try {
          await setDoc(doc(db, "users", cred.user.uid), {
            email,
            workspaceId,
            role,
            approved: isSuper,
            accountStatus: isSuper ? "active" : "pending",   // ← NEW
            displayName: cred.user.displayName || null,
            photoURL: cred.user.photoURL || null,
            provider: "password",
            createdAt: serverTimestamp()
          });
        } catch (profileErr) {
          console.error("[Signup] profile write failed:", profileErr);
          if (authError) {
            authError.textContent =
              "Account created, but profile setup failed. Check Firestore rules.";
          }
        }
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err) {
      console.error("[Auth] submit error:", err);
      if (authError) authError.textContent = friendlyAuthError(err.code);
    } finally {
      if (authSubmit) authSubmit.disabled = false;
    }
  });

  /* ---------- Google Sign-In / Sign-Up ---------- */
  const googleBtn = $("google-signin-btn");
  googleBtn?.addEventListener("click", async () => {
    if (authError) authError.textContent = "";

    const remember = getRememberMe();
    saveRememberMe(remember);

    googleBtn.disabled = true;
    try {
      try {
        await setPersistence(
          auth,
          remember ? browserLocalPersistence : browserSessionPersistence
        );
      } catch (persistErr) {
        console.warn("[Auth] setPersistence (google) failed:", persistErr);
      }

      const result = await signInWithPopup(auth, googleProvider);
      const signedInEmail = (result.user?.email || "").toLowerCase();
      console.log("[Auth] Signed in as:", signedInEmail);

      const cachedEmail = (localStorage.getItem("lastGoogleEmail") || "").toLowerCase();
      if (cachedEmail && cachedEmail !== signedInEmail) {
        console.warn("[Auth] Account changed — clearing cached session data");
        try {
          localStorage.removeItem("kurtPaletteV1");
          localStorage.removeItem("eloadNetworks:" + result.user.uid);
          localStorage.removeItem("eloadWallet:" + result.user.uid);
          localStorage.removeItem("storeDisplayName");
        } catch {}
      }
      localStorage.setItem("lastGoogleEmail", signedInEmail);
    } catch (err) {
      console.error("[Auth] Google error:", err);
      if (
        err.code === "auth/popup-closed-by-user" ||
        err.code === "auth/cancelled-popup-request"
      ) return;
      if (authError) authError.textContent = friendlyAuthError(err.code);
    } finally {
      googleBtn.disabled = false;
    }
  });

  /* ---------- Logout ---------- */
  $("logout-btn")?.addEventListener("click", () => signOut(auth));
  $("pending-logout")?.addEventListener("click", () => signOut(auth));

  /* ---------- Join workspace modal ---------- */
  $("join-workspace-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("join-workspace-error");
    const btn = $("join-workspace-submit");
    if (errEl) errEl.textContent = "";

    const code = valOf($("join-workspace-code")).trim();
    if (!code) {
      if (errEl) errEl.textContent = "Enter the invite code.";
      return;
    }

    if (btn) btn.disabled = true;
    try {
      const invite = await acceptWorkspaceInvite(code);
      showToast(`Joined "${invite.workspaceName || "workspace"}" ✅`);
      $("join-workspace-modal")?.classList.add("hidden");
      document.body.style.overflow = "";
    } catch (err) {
      console.error("[Join workspace]", err);
      if (errEl) errEl.textContent = err.message || "Could not join workspace";
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  /* ---------- Sign out from join modal ---------- */
  $("join-workspace-logout")?.addEventListener("click", () => signOut(auth));
}

/* =========================================================
   AUTH STATE OBSERVER
   ========================================================= */
export function initAuthHandlers({ onLoggedOut, onPending, onApproved, onTeardown }) {
  onAuthStateChanged(auth, async (user) => {
    if (state.unsubscribeUserDoc) {
      try { state.unsubscribeUserDoc(); } catch {}
      state.unsubscribeUserDoc = null;
    }
    if (state.unsubscribeWorkspace) {
      try { state.unsubscribeWorkspace(); } catch {}
      state.unsubscribeWorkspace = null;
    }
    onTeardown?.();

    const authScreen    = $("auth-screen");
    const pendingScreen = $("pending-screen");
    const appShell      = $("app-shell");

    /* ---------- Signed out ---------- */
    if (!user) {
      state.currentUser = null;
      state.currentUserData = null;
      state.currentWorkspace = null;
      authScreen?.classList.remove("hidden");
      pendingScreen?.classList.add("hidden");
      appShell?.classList.add("hidden");
      $("join-workspace-modal")?.classList.add("hidden");
      $("auth-form")?.reset();
      const authError = $("auth-error");
      if (authError) authError.textContent = "";
      restoreRememberMeUI();
      startAuthBgCarousel("auth-bg-slides");
      onLoggedOut?.();
      return;
    }

    /* ---------- Signed in ---------- */
    state.currentUser = user;
    if ($("user-email")) $("user-email").textContent = user.email || "";
    if ($("pending-email")) $("pending-email").textContent = user.email || "";

    const isSuper =
      (user.email || "").trim().toLowerCase() === SUPER_ADMIN_EMAIL.trim().toLowerCase();
    const userRef = doc(db, "users", user.uid);

    try {
      const snap = await getDoc(userRef);

      if (!snap.exists()) {
        // ---------- First-time profile creation ----------
        let workspaceId;
        let role;

        if (isSuper) {
          workspaceId = user.uid;
          role = "superadmin";
        } else {
          workspaceId = await createWorkspaceForOwner(user);
          role = "owner";
        }

        await setDoc(userRef, {
          email: (user.email || "").toLowerCase(),
          workspaceId,
          role,
          approved: isSuper,
          accountStatus: isSuper ? "active" : "pending",   // ← NEW
          displayName: user.displayName || null,
          photoURL: user.photoURL || null,
          provider: user.providerData?.[0]?.providerId || "password",
          createdAt: serverTimestamp()
        });

        console.log("[Auth] created user doc:", user.uid, "role:", role, "status:", isSuper ? "active" : "pending");
      } else {
        // ---------- Existing user doc — patch safe fields ----------
        const data = snap.data();
        const patch = {};

        if (isSuper && (data.role !== "superadmin" || data.approved !== true)) {
          patch.role = "superadmin";
          patch.approved = true;
          patch.accountStatus = "active";
          patch.workspaceId = data.workspaceId || user.uid;
        }

        // Backfill accountStatus for legacy users so rules keep working
        if (data.accountStatus === undefined) {
          if (data.approved === true) {
            patch.accountStatus = "active";
          } else if (data.approved === false) {
            patch.accountStatus = "pending";
          }
        }

        if (user.displayName && !data.displayName) patch.displayName = user.displayName;
        if (user.photoURL && !data.photoURL) patch.photoURL = user.photoURL;

        const provider = user.providerData?.[0]?.providerId;
        if (provider && !data.provider) patch.provider = provider;

        if (Object.keys(patch).length) {
          try {
            await updateDoc(userRef, patch);
            console.log("[Auth] patched user doc:", Object.keys(patch).join(", "));
          } catch (patchErr) {
            // Non-fatal — we just couldn't write safe updates
            console.warn("[Auth] patch skipped:", patchErr.code, patchErr.message);
          }
        }
      }
    } catch (err) {
      console.error("[Auth] profile setup FAILED:", err.code, err.message);
      const authError = $("auth-error");
      if (authError) {
        authError.textContent = `Profile setup failed: ${err.code || err.message}`;
      }
      authScreen?.classList.remove("hidden");
      appShell?.classList.add("hidden");
      pendingScreen?.classList.add("hidden");
      startAuthBgCarousel("auth-bg-slides");
      return;
    }

    /* ---------- Watch the user doc ---------- */
    state.unsubscribeUserDoc = onSnapshot(userRef, (docSnap) => {
      if (!docSnap.exists()) return;
      state.currentUserData = docSnap.data();
      const ud = state.currentUserData;

      /* ---- Determine approval status ---- */
      // New-style: accountStatus is the source of truth
      // Legacy fallback: approved == true
      const isActive = (ud.accountStatus === "active")
                       || (ud.accountStatus === undefined && ud.approved === true);

      /* ---- Not active (pending / suspended / rejected) ---- */
      if (!isActive) {
        authScreen?.classList.add("hidden");
        appShell?.classList.add("hidden");
        pendingScreen?.classList.remove("hidden");
        $("join-workspace-modal")?.classList.add("hidden");
        stopAuthBgCarousel();
        startAuthBgCarousel("pending-bg-slides");
        onPending?.();
        return;
      }

      /* ---- Active but no workspace → show join modal ---- */
      const hasWorkspace = !!ud.workspaceId && !!ud.role;

      if (!hasWorkspace) {
        authScreen?.classList.add("hidden");
        appShell?.classList.add("hidden");
        pendingScreen?.classList.add("hidden");
        $("join-workspace-modal")?.classList.remove("hidden");
        document.body.style.overflow = "hidden";
        return;
      }

      /* ---- Fully active → show the app ---- */
      $("join-workspace-modal")?.classList.add("hidden");
      pendingScreen?.classList.add("hidden");
      authScreen?.classList.add("hidden");
      appShell?.classList.remove("hidden");
      stopAuthBgCarousel();
      document.body.style.overflow = "";

      const isRealSuper = ud.role === "superadmin";
      const navAdmin = $("nav-admin");
      if (navAdmin) navAdmin.classList.toggle("hidden", !isRealSuper);

      if (isRealSuper) {
        import("./app.js").then(m => {
          m.startUserAdminListener?.();
          m.startWorkspaceAdminListener?.();
        }).catch(() => {});
      }

      /* ---- Watch the workspace doc ---- */
      if (state.unsubscribeWorkspace) {
        try { state.unsubscribeWorkspace(); } catch {}
        state.unsubscribeWorkspace = null;
      }
      const wsId = ud.workspaceId;
      if (wsId) {
        state.unsubscribeWorkspace = onSnapshot(
          doc(db, "workspaces", wsId),
          (wsSnap) => {
            state.currentWorkspace = wsSnap.exists()
              ? { id: wsSnap.id, ...wsSnap.data() }
              : null;
          },
          (err) => console.warn("[workspace listener]", err.code, err.message)
        );
      }

      onApproved?.(ud);
    }, (err) => {
      console.error("[Auth] profile watch FAILED:", err.code, err.message);
      showToast(`Profile stream: ${err.code || err.message} ❌`);
    });
  });
}