// Re-export the main frontend's Firebase config so we don't drift. The KDS
// signs in the same way as the manager dashboard (Google), just with a
// dedicated kitchen kiosk account in the email allowlist.
export { auth, signInWithGoogle, signOutUser } from "../../frontend/src/firebase";
export { onAuthStateChanged } from "firebase/auth";
