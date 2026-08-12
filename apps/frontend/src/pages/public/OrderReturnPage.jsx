import { useEffect } from "react";

/**
 * Guest-facing return pages for Stripe Checkout (voice-order payment links).
 * PUBLIC — the guest has no account and never signs in. Deliberately static:
 * no API calls, no order details, no PII. The venue's own SMS/receipt carries
 * the specifics; this page only confirms the outcome.
 */
export function OrderReturnPage({ outcome }) {
  useEffect(() => {
    // Stripe appends ?session_id=… to the success URL. Scrub it immediately so
    // the session id (a live payment-page capability while unexpired) never
    // lingers in the address bar, browser history, or Sentry breadcrumbs.
    if (window.location.search) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const paid = outcome === "paid";
  return (
    <div className="error-boundary-shell" role="status" aria-live="polite">
      <div className="error-boundary-card">
        <h1>{paid ? "Payment received" : "Payment not completed"}</h1>
        <p>
          {paid
            ? "Thanks — the kitchen has your order. See you soon!"
            : "No payment was taken. You can try the link in your text message again, or simply pay when you arrive."}
        </p>
        <p className="error-boundary-detail">
          {paid
            ? "A receipt will be emailed to you if you entered your email at checkout."
            : "Questions? Just call the restaurant back."}
        </p>
      </div>
    </div>
  );
}
