import { useState } from "react";

import { getAdminRestaurantSubscription } from "../../../api";
import { AdminAction } from "../../../components/admin/AdminAction";
import { Badge } from "../../../components/admin/Badge";
import { SectionCard } from "../../../components/admin/SectionCard";
import { useToast } from "../../../components/admin/Toast";

const STRIPE_CUSTOMER_SEARCH = "https://dashboard.stripe.com/search?query=";

/**
 * Billing as it stands today: read-only, and honest about it. Mutating a
 * subscription — extending a trial, changing a plan, pausing collection — is a
 * Stripe write the backend cannot yet make, so this card links out rather than
 * showing a control that would not work.
 */
export function BillingCard({ venueId, venueName, billing }) {
  const [subscription, setSubscription] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = async () => {
    setBusy(true);
    try {
      const result = await getAdminRestaurantSubscription(venueId);
      setSubscription(result.subscription ?? null);
    } catch (e) {
      toast.error(e.message ?? "Couldn't read the subscription from Stripe.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      title="Billing"
      icon="credit_card"
      badge={
        billing?.has_stripe_customer ? (
          <Badge state="ok">Stripe customer</Badge>
        ) : (
          <Badge state="neutral">No Stripe customer</Badge>
        )
      }
      subtitle="Read-only. Trials, plans and credits are changed in Stripe until those writes exist here."
      actions={
        <a
          className="ghost-button"
          href={`${STRIPE_CUSTOMER_SEARCH}${encodeURIComponent(venueName)}`}
          target="_blank"
          rel="noreferrer"
        >
          Open in Stripe
        </a>
      }
    >
      <div className="adm-kv-grid">
        <div className="adm-kv">
          <span className="adm-kv-label">Connect charges</span>
          <span className="adm-kv-value">{billing?.connect_charges_enabled ? "on" : "off"}</span>
        </div>
        <div className="adm-kv">
          <span className="adm-kv-label">Connect payouts</span>
          <span className="adm-kv-value">{billing?.connect_payouts_enabled ? "on" : "off"}</span>
        </div>
      </div>

      {subscription === undefined ? (
        <AdminAction icon="cloud_download" busy={busy} onAct={load} busyLabel="Reading Stripe…">
          Read the subscription from Stripe
        </AdminAction>
      ) : subscription === null ? (
        <p className="admin-muted">
          Stripe has no subscription for this venue — it has not checked out, or it is on a
          manual arrangement.
        </p>
      ) : (
        <div className="adm-kv-grid">
          <div className="adm-kv">
            <span className="adm-kv-label">Plan</span>
            <span className="adm-kv-value">{subscription.plan_name ?? "—"}</span>
          </div>
          <div className="adm-kv">
            <span className="adm-kv-label">Status</span>
            <span className="adm-kv-value">{subscription.status ?? "—"}</span>
          </div>
          <div className="adm-kv">
            <span className="adm-kv-label">Renews</span>
            <span className="adm-kv-value">{subscription.current_period_end ?? "—"}</span>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
