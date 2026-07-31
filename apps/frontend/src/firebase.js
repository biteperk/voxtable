import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getRedirectResult,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile
} from "firebase/auth";
import { getStorage, ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";

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

/**
 * Hex SHA-256 of a Blob — dedupes menu re-uploads server-side.
 *
 * Always hash the PREPARED page, never the original file. On the 413 MB menu
 * that prompted this work, `arrayBuffer()` on the source is itself enough to
 * kill a phone tab — and the hash should identify what the worker will actually
 * fetch, which is the rendered page.
 */
export async function sha256Hex(blob) {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Combined hash for a multi-page menu, so re-uploading the same menu dedupes. */
export async function sha256OfPages(blobs) {
  const perPage = [];
  for (const blob of blobs) perPage.push(await sha256Hex(blob));
  const joined = new TextEncoder().encode(perPage.join(":"));
  const digest = await crypto.subtle.digest("SHA-256", joined);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * How long a transfer may make NO progress before we call it dead.
 *
 * This replaces a flat 20-second cap on the whole upload. That cap was the
 * incident: a 413 MB file needs about six minutes on mobile data, so it was
 * killed at 20 seconds and reported as "photo import isn't available right now"
 * — a sentence that sent the owner off to type their menu by hand instead of
 * simply waiting. A healthy-but-slow transfer must never be treated as a
 * failure; a genuinely stalled one still must.
 */
const UPLOAD_STALL_MS = 45_000;
/** Absolute ceiling, so a trickling connection can't hang the step forever. */
const UPLOAD_CEILING_MS = 10 * 60_000;

function stalledError() {
  const error = new Error("Upload stopped — check your connection and try again.");
  error.code = "UPLOAD_STALLED";
  return error;
}

/**
 * Upload one prepared menu page to Firebase Storage, straight from the browser
 * so large binaries never touch our API.
 *
 * Returns `{ promise, cancel }`. Progress is reported as a percentage, and the
 * upload is genuinely cancellable — a 12-page menu takes long enough that a
 * dead Cancel button is a real complaint.
 */
export function uploadMenuPage(restaurantId, blob, { fileName = "page.jpg", onProgress } = {}) {
  const safeName = String(fileName).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  const path = `menu-imports/${restaurantId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("Sign in again to upload your menu.");
  const task = uploadBytesResumable(ref(storage, path), blob, {
    contentType: blob.type || "image/jpeg",
    // REQUIRED by storage.rules — reads are pinned to whoever uploaded, so an
    // object without this is both unwritable and later unreadable.
    customMetadata: { uid }
  });

  const promise = new Promise((resolve, reject) => {
    let lastBytes = -1;
    let lastMovedAt = Date.now();
    const startedAt = Date.now();

    const watchdog = setInterval(() => {
      const now = Date.now();
      if (now - lastMovedAt > UPLOAD_STALL_MS || now - startedAt > UPLOAD_CEILING_MS) {
        clearInterval(watchdog);
        task.cancel();
        reject(stalledError());
      }
    }, 5_000);

    task.on(
      "state_changed",
      (snapshot) => {
        if (snapshot.bytesTransferred !== lastBytes) {
          lastBytes = snapshot.bytesTransferred;
          lastMovedAt = Date.now();
        }
        if (snapshot.totalBytes > 0) {
          onProgress?.((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
        }
      },
      (error) => {
        clearInterval(watchdog);
        reject(error);
      },
      () => {
        clearInterval(watchdog);
        getDownloadURL(task.snapshot.ref).then(resolve).catch(reject);
      }
    );
  });

  return { promise, cancel: () => task.cancel() };
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

// ===== Email/password accounts (self-serve signup) =====

// The verification link runs through Firebase's hosted action handler, which
// applies the code and then redirects to this URL — our own screen picks the
// user up from there. The origin must be in Firebase's authorized domains.
const verifyContinueUrl = () => ({ url: `${window.location.origin}/verify-email` });

/**
 * Create an email/password account for a restaurant representative.
 * Deliberately does NOT send Firebase's verification email here — the verify
 * screen owns sending (a branded 6-digit code via our backend, or the Firebase
 * link only as its legacy fallback), so signup can't double-send.
 * Returns the (signed-in, unverified) user; the caller routes to /verify-email.
 */
export async function createAccount({ name, email, password }) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  if (name) {
    await updateProfile(cred.user, { displayName: name });
  }
  return cred.user;
}

export async function signInWithEmail(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

/** Re-send the verification email for the CURRENT signed-in user. */
export async function resendVerification() {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in.");
  await sendEmailVerification(user, verifyContinueUrl());
}

export async function sendPasswordReset(email) {
  await sendPasswordResetEmail(auth, email);
}
