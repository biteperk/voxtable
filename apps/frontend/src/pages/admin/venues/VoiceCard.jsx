import { AdminAction } from "../../../components/admin/AdminAction";
import { Badge } from "../../../components/admin/Badge";
import { SectionCard } from "../../../components/admin/SectionCard";
import { relativeTime } from "../../../lib/format";
import { LINE_LABEL, LINE_TONE, lineExplanation, lineState } from "../../../lib/venueLine";

/**
 * The voice card, telling the truth.
 *
 * It reads the bindings AND the pause flag (see lib/venueLine.js): the previous
 * version read only `voice_paused_at`, so a venue with no number and no agent
 * was shown a green "Live" pill, told that "Bella is answering and taking
 * bookings", and offered a Pause button for a line that cannot ring.
 */
export function VoiceCard({ prov, voicePausedAt, busy, onPause, onResume, onBindLine }) {
  const venue = { ...prov, voice_paused_at: voicePausedAt };
  const state = lineState(venue);
  const bound = state === "live" || state === "paused";

  return (
    <SectionCard
      title="Voice"
      icon="record_voice_over"
      badge={<Badge state={LINE_TONE[state]}>{LINE_LABEL[state]}</Badge>}
      subtitle={lineExplanation(venue)}
    >
      {voicePausedAt ? (
        <p className="admin-muted">
          Paused {relativeTime(new Date(voicePausedAt))}. The owner can also resume this
          themselves from their Profile page.
        </p>
      ) : null}

      <div className="adm-card-actions">
        {!bound ? (
          // Nothing to pause. Offer the thing that actually needs doing.
          <AdminAction icon="link" onAct={onBindLine}>
            Bind a line
          </AdminAction>
        ) : voicePausedAt ? (
          <AdminAction tone="primary" icon="play_arrow" busy={busy} onAct={onResume}>
            Resume phone bookings
          </AdminAction>
        ) : (
          <AdminAction icon="pause" busy={busy} onAct={onPause}>
            Pause phone bookings
          </AdminAction>
        )}
      </div>

      {bound ? (
        <p className="admin-muted">
          Pausing takes effect on the next call, and bookings are refused server-side even
          mid-call — so it holds for a guest already talking to Bella.
        </p>
      ) : null}
    </SectionCard>
  );
}
