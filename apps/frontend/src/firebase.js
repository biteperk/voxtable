import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  getRedirectResult,
  signInWithPopup,
  signInWithRedirect,
  signOut
} from "firebase/auth";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";

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
export const storage = getStorage(app);

/** Hex SHA-256 of a File/Blob — used to dedupe menu re-uploads server-side. */
export async function sha256Hex(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Upload a menu photo/PDF straight to Firebase Storage (keeps large binaries
 * off our API). Returns the download URL + file hash + inferred kind for the
 * OCR ingestion job.
 */
// Firebase Storage calls hang indefinitely when the bucket/CORS isn't reachable
// (e.g. the Storage bucket isn't provisioned). Bound them so the menu step fails
// fast and the owner can fall back to the manual editor instead of spinning on
// "Uploading…" forever.
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function uploadMenuFile(restaurantId, file) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  const path = `menu-imports/${restaurantId}/${Date.now()}-${safeName}`;
  const failMsg = "Photo import isn't available right now — please add your menu manually below.";
  const snap = await withTimeout(
    uploadBytes(ref(storage, path), file, { contentType: file.type || "application/octet-stream" }),
    20000,
    failMsg
  );
  const url = await withTimeout(getDownloadURL(snap.ref), 10000, failMsg);
  const sha256 = await sha256Hex(file);
  const sourceKind =
    (file.type || "").includes("pdf") || /\.pdf$/i.test(file.name) ? "pdf" : "image";
  return { url, sha256, sourceKind };
}

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
