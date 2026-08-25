// Firebase auth error-code → friendly message. The only such mapping in the
// app — keep every auth surface (login, verify, invite) pointed here so copy
// stays consistent.
//
// Note on enumeration protection: Firebase's "email enumeration protection"
// (on by default for newer projects) reports wrong-password AND unknown-user
// as auth/invalid-credential, so those share one combined message. Creating a
// duplicate account still surfaces auth/email-already-in-use.

const MESSAGES = {
  "auth/email-already-in-use":
    "You already have a VoxTable account with this email — switch to Sign in.",
  "auth/invalid-email": "That email address doesn't look right — please re-check it.",
  "auth/weak-password": "Please choose a password of at least 8 characters.",
  "auth/missing-password": "Please enter your password.",
  "auth/wrong-password": "Incorrect email or password. Try again, or use “Forgot password?”.",
  "auth/user-not-found": "Incorrect email or password. Try again, or use “Forgot password?”.",
  "auth/invalid-credential": "Incorrect email or password. Try again, or use “Forgot password?”.",
  "auth/user-disabled": "This account has been disabled. Contact hello@biteperk.com.au.",
  "auth/too-many-requests":
    "No rush — that was a few tries in quick succession. Give it a moment, then try again.",
  "auth/network-request-failed":
    "Couldn't reach the sign-in service. This is usually an ad blocker or " +
    "privacy extension blocking identitytoolkit.googleapis.com. Try disabling " +
    "extensions for this site, or use an incognito window.",
  "auth/popup-blocked": "Your browser blocked the sign-in popup — allow popups and try again.",
  "auth/popup-closed-by-user": "Sign-in cancelled.",
  "auth/cancelled-popup-request": "Sign-in cancelled.",
  "auth/unauthorized-continue-uri":
    "Sign-up is misconfigured for this domain — contact hello@biteperk.com.au."
};

export function authErrorMessage(err) {
  const code = err && err.code;
  if (code && MESSAGES[code]) return MESSAGES[code];
  // Firebase's persistence layer can throw bare Errors with no auth/* code
  // (e.g. "Database is closing/hidden" from IndexedDB mid-popup). Those are
  // SDK internals, not something a venue owner can act on — never show them.
  if (!code) return "Sign-in didn't finish — please try again.";
  return (err && err.message) || String(err);
}
