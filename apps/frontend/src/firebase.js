import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  getRedirectResult,
  signInWithPopup,
  signInWithRedirect,
  signOut
} from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyD1NZt3Ov0Esu-krdijIKzlQZ8qtgG6pcg",
  authDomain: "vocotable.firebaseapp.com",
  projectId: "vocotable",
  storageBucket: "vocotable.firebasestorage.app",
  messagingSenderId: "110560713396",
  appId: "1:110560713396:web:d90c8ffa1fe04fc5e915e1",
  measurementId: "G-LRHRWVXCJW"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

const provider = new GoogleAuthProvider();

/**
 * Try popup first (faster UX), fall back to full-page redirect if popup
 * is blocked or the network request fails (typical with ad-blockers /
 * privacy extensions that filter identitytoolkit.googleapis.com).
 */
export async function signInWithGoogle() {
  try {
    return await signInWithPopup(auth, provider);
  } catch (err) {
    const code = err && err.code;
    const networkBlocked =
      code === "auth/network-request-failed" ||
      code === "auth/popup-blocked" ||
      code === "auth/popup-closed-by-user" ||
      code === "auth/internal-error";
    if (networkBlocked) {
      // signInWithRedirect navigates the page; resolution happens via
      // getRedirectResult() after the redirect back. We don't return a
      // useful value here because the page is about to navigate away.
      await signInWithRedirect(auth, provider);
      return null;
    }
    throw err;
  }
}

/** Call once on app boot to surface any pending redirect-sign-in result. */
export async function completeRedirectSignIn() {
  try {
    return await getRedirectResult(auth);
  } catch (err) {
    return null;
  }
}

export async function signOutUser() {
  return signOut(auth);
}
