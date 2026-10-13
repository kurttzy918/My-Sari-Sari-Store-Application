/* firebase.js — Firebase init (shared) */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, initializeRecaptchaConfig
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyALhYN9Wufpqw8OxBlsvmEwpCrZjtGAtQo",
  authDomain: "kurt-inventory-pos.firebaseapp.com",
  projectId: "kurt-inventory-pos",
  storageBucket: "kurt-inventory-pos.firebasestorage.app",
  messagingSenderId: "480909019162",
  appId: "1:480909019162:web:c0c9c6254cac2c021ee9a3",
  measurementId: "G-N3ET64JKNG"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

if (typeof initializeRecaptchaConfig === "function") {
  try {
    initializeRecaptchaConfig(auth)
      .then(() => console.log("[reCAPTCHA] Enterprise config initialized."))
      .catch((e) => console.warn("[reCAPTCHA] init skipped:", e?.code || e?.message));
  } catch (e) {
    console.warn("[reCAPTCHA] init skipped:", e?.message);
  }
}

let dbInstance;
try {
  dbInstance = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
  console.log("[Firestore] offline persistence enabled");
} catch (e) {
  console.warn("[Firestore] offline persistence failed, using default:", e);
  dbInstance = initializeFirestore(app, {});
}
export const db = dbInstance;