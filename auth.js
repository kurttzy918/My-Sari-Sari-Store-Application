/* auth.js — Authentication + auth screen + pending screen */
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged,
  GoogleAuthProvider, signInWithPopup,
  setPersistence, browserLocalPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp, onSnapshot
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
  // Force the full account chooser even if a session exists
  login_hint: "",
});

/* =========================================================
   REMEMBER ME
   ========================================================= */
const REMEMBER_KEY = "rememberMe";

function getRememberMe() {
  const el = document.getElementById("remember-me");
  if (el) return !!el.checked;
  // Fallback to stored preference; default = true (stay signed in)
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
  // Support MULTIPLE carousels with the same class (topbar + sidebar)
  const containers = document.querySelectorAll(containerSelector);
  if (!containers.length) return;

  containers.forEach((container) => {
    const items = container.querySelectorAll(itemSelector);
    if (!items.length) return;

    // Single-item: just show it, no timer needed
    if (items.length === 1) {
      items[0].classList.add("active");
      return;
    }

    // Multi-item: rotate
    let idx = 0;
    items.forEach((el, i) => el.classList.toggle("active", i === 0));

    setInterval(() => {
      // If the parent got removed (e.g., page switched), skip
      if (!items[idx] || !items[idx].isConnected) return;
      items[idx].classList.remove("active");
      idx = (idx + 1) % items.length;
      items[idx].classList.add("active");
    }, intervalMs);
  });
}

/* =========================================================
   AUTH MODE (login vs signup)
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

  // Swap the Google button label
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

    // Google / popup related
    "auth/account-exists-with-different-credential":
      "This email is already registered with a password. Sign in with email instead.",
    "auth/popup-blocked":
      "Popup blocked. Allow popups for this site, then try again.",
    "auth/popup-closed-by-user": "Sign-in was cancelled.",
    "auth/cancelled-popup-request": "Sign-in was cancelled.",
    "auth/operation-not-allowed":
      "Google sign-in is not enabled. Enable it in Firebase Console → Authentication → Sign-in method → Google.",

    // 👇 now includes the actual hostname so you know exactly what to add
    "auth/unauthorized-domain":
      `Domain "${host}" isn't authorized.\n\n` +
      `Add it in Firebase Console → Authentication → Settings → Authorized domains.\n\n` +
      `Enter EXACTLY this (no https://, no trailing slash): ${host}`,

    "auth/internal-error":
      "Sign-in service had a hiccup. Try again in a moment."
  };

  // Special-case: file:// won't work at all
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
   INIT AUTH UI
   ========================================================= */
export function initAuthUI() {
  // Restore remember-me checkbox state on load
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

    // Persist remember-me choice + apply Firebase persistence BEFORE auth call
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
        try {
          await setDoc(doc(db, "users", cred.user.uid), {
            email,
            workspaceId: cred.user.uid,
            role: isSuper ? "superadmin" : "user",
            approved: isSuper,
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

      // Confirm the user picked the account they expect
      const signedInEmail = (result.user?.email || "").toLowerCase();
      console.log("[Auth] Signed in as:", signedInEmail);

      // If Firebase already had a different cached account, force a hard reset
      const cachedEmail = (localStorage.getItem("lastGoogleEmail") || "").toLowerCase();
      if (cachedEmail && cachedEmail !== signedInEmail) {
        console.warn("[Auth] Account changed — clearing cached session data");
        // Clear stale local data associated with the previous account
        try {
          localStorage.removeItem("kurtPaletteV1");
          localStorage.removeItem("eloadNetworks:" + result.user.uid);
          localStorage.removeItem("eloadWallet:" + result.user.uid);
        } catch {}
      }
      localStorage.setItem("lastGoogleEmail", signedInEmail);
    } catch (err) {
      console.error("[Auth] Google error:", err);
      // Silent exit for user-cancelled popups
      if (
        err.code === "auth/popup-closed-by-user" ||
        err.code === "auth/cancelled-popup-request"
      ) {
        return;
      }
      if (authError) authError.textContent = friendlyAuthError(err.code);
    } finally {
      googleBtn.disabled = false;
    }
  });

  /* ---------- Logout buttons ---------- */
  $("logout-btn")?.addEventListener("click", () => signOut(auth));
  $("pending-logout")?.addEventListener("click", () => signOut(auth));
}

/* =========================================================
   AUTH STATE OBSERVER
   ========================================================= */
export function initAuthHandlers({ onLoggedOut, onPending, onApproved, onTeardown }) {
  onAuthStateChanged(auth, async (user) => {
    // Teardown previous session
    if (state.unsubscribeUserDoc) {
      try { state.unsubscribeUserDoc(); } catch {}
      state.unsubscribeUserDoc = null;
    }
    onTeardown?.();

    const authScreen   = $("auth-screen");
    const pendingScreen = $("pending-screen");
    const appShell     = $("app-shell");

    /* ---------- Signed out ---------- */
    if (!user) {
      state.currentUser = null;
      state.currentUserData = null;
      authScreen?.classList.remove("hidden");
      pendingScreen?.classList.add("hidden");
      appShell?.classList.add("hidden");
      $("auth-form")?.reset();
      const authError = $("auth-error");
      if (authError) authError.textContent = "";
      // Re-restore remember-me checkbox after the form reset
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
        // First login (email signup or Google) → create the profile doc
        await setDoc(userRef, {
          email: user.email,
          workspaceId: user.uid,
          role: isSuper ? "superadmin" : "user",
          approved: isSuper,
          displayName: user.displayName || null,
          photoURL: user.photoURL || null,
          provider: user.providerData?.[0]?.providerId || "password",
          createdAt: serverTimestamp()
        });
      } else {
        // Merge updated Google profile info into the existing doc
        const data = snap.data();
        const patch = {};

        if (isSuper && (data.role !== "superadmin" || data.approved !== true)) {
          patch.role = "superadmin";
          patch.approved = true;
        }
        if (user.displayName && !data.displayName) {
          patch.displayName = user.displayName;
        }
        if (user.photoURL && !data.photoURL) {
          patch.photoURL = user.photoURL;
        }
        const provider = user.providerData?.[0]?.providerId;
        if (provider && !data.provider) {
          patch.provider = provider;
        }

        if (Object.keys(patch).length) {
          await updateDoc(userRef, patch);
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

    /* ---------- Watch the user doc for approval changes ---------- */
    state.unsubscribeUserDoc = onSnapshot(userRef, (docSnap) => {
      if (!docSnap.exists()) return;
      state.currentUserData = docSnap.data();

      if (!state.currentUserData.approved) {
        authScreen?.classList.add("hidden");
        appShell?.classList.add("hidden");
        pendingScreen?.classList.remove("hidden");
        stopAuthBgCarousel();
        startAuthBgCarousel("pending-bg-slides");
        onPending?.();
        return;
      }

      pendingScreen?.classList.add("hidden");
      authScreen?.classList.add("hidden");
      appShell?.classList.remove("hidden");
      stopAuthBgCarousel();

      const navAdmin = $("nav-admin");
      const isRealSuper = state.currentUserData.role === "superadmin";
      if (navAdmin) navAdmin.classList.toggle("hidden", !isRealSuper);

      // Kick off the users listener the moment a real super admin lands
      if (isRealSuper) {
        import("./app.js").then(m => {
          m.startUserAdminListener?.();
        }).catch(() => {});
      }

      onApproved?.(state.currentUserData);
    }, (err) => {
      console.error("[Auth] profile watch FAILED:", err.code, err.message);
      showToast(`Profile stream: ${err.code || err.message} ❌`);
    });
  });
}