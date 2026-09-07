import { useCallback, useEffect, useRef, useState } from "react";

import {
  adminBindProvisioning,
  adminGoLive,
  adminSetVoicePaused,
  adminUnbindProvisioning,
  getAdminRestaurant
} from "../../../api";
import { Badge } from "../../../components/admin/Badge";
import { SectionCard } from "../../../components/admin/SectionCard";
import { SkeletonLines } from "../../../components/admin/Skeleton";
import { useToast } from "../../../components/admin/Toast";
import { Icon } from "../../../components/Icon";
import { relativeTime } from "../../../lib/format";
import { LINE_LABEL, LINE_TONE, lineState, readinessChecks } from "../../../lib/venueLine";
import { BillingCard } from "./BillingCard";
import { DangerModal } from "./DangerModal";
import { PhoneLineCard } from "./PhoneLineCard";
import { TeamCard } from "./TeamCard";
import { VoiceCard } from "./VoiceCard";

/**
 * One venue, in a side panel.
 *
 * The list used to expand inline, which pushed every venue below the expanded
 * one far off the screen — with two venues open the page was unreadable. A
 * drawer keeps the list in place and makes a venue linkable
 * (`/admin/venues?venue=<id>`).
 */
export function VenueDrawer({ venueId, venueName, publishedTerms, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dangerOpen, setDangerOpen] = useState(false);
  const toast = useToast();
  const panelRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const next = await getAdminRestaurant(venueId);
      setDetail(next);
      setError(null);
      return next;
    } catch (e) {
      setError(e.message ?? "Couldn't load this venue");
      return null;
    }
  }, [venueId]);

  useEffect(() => {
    setDetail(null);
    load();
  }, [load]);

  useEffect(() => {
    panelRef.current?.focus();
    const onKeyDown = (e) => {
      // The danger modal handles its own Escape and stops propagation, so this
      // never closes the drawer out from under it.
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  /**
   * Every mutation reports, and the panel re-renders from a FRESH READ rather
   * than from the form that was submitted — an optimistic render is exactly how
   * a save that never happened can look successful.
   */
  const run = async (message, fn, { undo } = {}) => {
    setBusy(true);
    try {
      await fn();
      await load();
      onChanged();
      toast.success(message, undo ? { action: undo } : undefined);
      return true;
    } catch (e) {
      toast.error(e.message ?? "That didn't work.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const prov = detail?.provisioning;
  // The row's concurrency token, sent back as If-Match on every mutation below.
  const version = detail?.version ?? null;
  const state = prov ? lineState({ ...prov, voice_paused_at: detail?.voice_paused_at }) : "no_line";
  const termsVersion = detail?.legal?.terms_version;
  const termsDrift = publishedTerms && termsVersion && termsVersion !== publishedTerms;

  const unbind = async (body) => {
    // What we are about to clear, captured BEFORE the write, so Undo can put
    // the same values back. #425 made this safe: re-binding no longer re-sends
    // the venue's "your number is ready" email.
    const previous = {};
    for (const field of body.fields) {
      const value = prov?.[field];
      if (value !== null && value !== undefined && value !== "") previous[field] = String(value);
    }
    // The API refuses a half-bind, so an Undo of either half must resend both.
    if (previous.twilio_phone_number || previous.retell_agent_id) {
      if (prov?.twilio_phone_number) previous.twilio_phone_number = prov.twilio_phone_number;
      if (prov?.retell_agent_id) previous.retell_agent_id = prov.retell_agent_id;
    }

    const ok = await run("Phone line disconnected.", () => adminUnbindProvisioning(venueId, body, version), {
      undo: {
        label: "Undo",
        // Deliberately sends no If-Match: the unbind we are reversing has
        // already moved the version on, so the token captured here is stale by
        // definition and would 409 against our own write.
        onAct: () =>
          run("Bindings restored.", () => adminBindProvisioning(venueId, previous))
      }
    });
    if (ok) setDangerOpen(false);
  };

  return (
    <div className="adm-drawer-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        className="adm-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${venueName} — venue detail`}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="adm-drawer-head">
          <div>
            <h2>{venueName}</h2>
            <div className="adm-drawer-chips">
              <Badge state={detail?.provisioning?.onboarding_status === "live" ? "ok" : "neutral"} icon={null}>
                {(detail?.provisioning?.onboarding_status ?? "…").replace(/_/g, " ")}
              </Badge>
              <Badge state={LINE_TONE[state]}>{LINE_LABEL[state]}</Badge>
              {termsVersion ? (
                <Badge state={termsDrift ? "warn" : "ok"}>
                  terms {termsVersion}
                  {termsDrift ? ` → ${publishedTerms} published` : ""}
                </Badge>
              ) : (
                <Badge state="warn">no terms recorded</Badge>
              )}
            </div>
          </div>
          <button type="button" className="ghost-button" onClick={onClose} aria-label="Close venue detail">
            <Icon name="close" />
          </button>
        </header>

        {error ? (
          <div className="menu-error" role="alert">
            {error}
          </div>
        ) : null}

        {!detail ? (
          <SectionCard title="Loading this venue">
            <SkeletonLines lines={6} label={`Loading ${venueName}`} />
          </SectionCard>
        ) : (
          <div className="adm-drawer-body">
            <SectionCard
              title="Can this venue take a booking?"
              icon="fact_check"
              subtitle="Every piece Bella needs before she can honour what she promises a guest."
            >
              <ul className="adm-readiness">
                {readinessChecks(detail).map((check) => (
                  <li key={check.key}>
                    <Badge state={check.ok ? "ok" : "warn"}>{check.ok ? "Ready" : "Missing"}</Badge>
                    <span>{check.label}</span>
                    {check.note ? <span className="admin-muted">{check.note}</span> : null}
                  </li>
                ))}
              </ul>
              <div className="adm-kv-grid">
                <div className="adm-kv">
                  <span className="adm-kv-label">Today</span>
                  <span className="adm-kv-value">
                    {detail.activity_today?.calls ?? 0} calls · {detail.activity_today?.bookings ?? 0} bookings
                  </span>
                </div>
                <div className="adm-kv">
                  <span className="adm-kv-label">Last call</span>
                  <span className="adm-kv-value">
                    {detail.readiness?.last_call_at
                      ? relativeTime(new Date(detail.readiness.last_call_at))
                      : "never"}
                  </span>
                </div>
                <div className="adm-kv">
                  <span className="adm-kv-label">Last booking</span>
                  <span className="adm-kv-value">
                    {detail.readiness?.last_booking_at
                      ? relativeTime(new Date(detail.readiness.last_booking_at))
                      : "never"}
                  </span>
                </div>
              </div>
            </SectionCard>

            <VoiceCard
              prov={prov}
              voicePausedAt={detail.voice_paused_at}
              busy={busy}
              onPause={() => run("Phone bookings paused.", () => adminSetVoicePaused(venueId, true))}
              onResume={() => run("Phone bookings resumed.", () => adminSetVoicePaused(venueId, false))}
              onBindLine={() =>
                document
                  .querySelector(".adm-drawer .admin-field input")
                  ?.scrollIntoView({ block: "center" })
              }
            />

            <PhoneLineCard
              prov={prov}
              busy={busy}
              onBind={(payload) => run("Bindings saved.", () => adminBindProvisioning(venueId, payload, version))}
              onGoLive={() => run("This venue is live.", () => adminGoLive(venueId, version))}
            />

            <BillingCard venueId={venueId} venueName={venueName} billing={detail.billing} />

            <SectionCard title="Legal" icon="gavel">
              <div className="adm-kv-grid">
                <div className="adm-kv">
                  <span className="adm-kv-label">Last acceptance</span>
                  <span className="adm-kv-value">
                    {detail.legal?.latest_acceptance
                      ? `${detail.legal.latest_acceptance.document_set_version} · ${new Date(
                          detail.legal.latest_acceptance.accepted_at
                        ).toLocaleDateString()} · ${detail.legal.latest_acceptance.channel}`
                      : "none recorded"}
                  </span>
                </div>
                <div className="adm-kv">
                  <span className="adm-kv-label">Retention</span>
                  <span className="adm-kv-value">
                    {detail.legal?.elections?.retention_days
                      ? `${detail.legal.elections.retention_days} days · ${detail.legal.elections.storage_tier ?? ""}`
                      : "—"}
                  </span>
                </div>
                <div className="adm-kv">
                  <span className="adm-kv-label">Legal entity</span>
                  <span className="adm-kv-value">
                    {detail.legal?.elections?.client_legal_name ?? "—"}
                    {detail.legal?.elections?.client_abn
                      ? ` · ABN ${detail.legal.elections.client_abn}`
                      : ""}
                  </span>
                </div>
              </div>
            </SectionCard>

            <TeamCard members={detail.members} />

            <SectionCard
              title="Danger zone"
              icon="warning"
              tone="danger"
              subtitle="Disconnecting the line is the one action here a guest can feel immediately."
            >
              <button type="button" className="ghost-button adm-btn-danger" onClick={() => setDangerOpen(true)}>
                <Icon name="link_off" />
                Disconnect this venue&apos;s phone line…
              </button>
            </SectionCard>
          </div>
        )}

        {dangerOpen ? (
          <DangerModal
            prov={prov}
            venueName={venueName}
            busy={busy}
            onClose={() => setDangerOpen(false)}
            onConfirm={unbind}
          />
        ) : null}
      </aside>
    </div>
  );
}
