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
    <div className="error-boundary-shell order-return-shell" role="status" aria-live="polite">
      <div className="error-boundary-card">
        <h1>{paid ? "Payment received" : "Payment not completed"}</h1>
        <p>
          {paid
            ? "Thanks! The kitchen has your order. See you soon."
            : "No payment was taken. You can try the link in your text message again, or simply pay when you arrive."}
        </p>
        <p className="order-return-note">
          {paid
            ? "A receipt is on its way: a text to the phone your payment link came to, and an email from Stripe to the address you entered at checkout."
            : "Questions? Just call the restaurant back."}
        </p>
      </div>
    </div>
  );
}
