import { useEffect, useRef, useState } from "react";
import { getCallLog } from "../../api";
import {
  callerDisplayName,
  capitalize,
  formatDuration,
  formatPhoneDisplay,
  humanizeIntent,
  humanizeOutcome,
  parseTranscript
} from "../../lib/format";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Icon } from "../../components/Icon";
import { DashboardShell } from "./DashboardShell";

export function LiveFeedDetailPage({ navigate, callId, path }) {
  const [callLog, setCallLog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const isPhone = useMediaQuery("(max-width: 767px)");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCallLog(callId)
      .then((res) => !cancelled && setCallLog(res.call_log ?? null))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [callId]);

  const messages = parseTranscript(callLog?.transcript);
  const isLive = !!callLog && !callLog.ended_at;
  const durationLabel =
    callLog?.duration_seconds != null ? formatDuration(callLog.duration_seconds) : "—";
  const intentLabel = callLog ? humanizeIntent(callLog) : "—";
  const sentiment = callLog?.user_sentiment ?? null;
  const outcome = callLog?.booking_outcome ?? null;
  // Prefer the caller's name (booking or post-call analysis); fall back to the
  // formatted phone, then a generic label.
  const callerName = callLog ? callerDisplayName(callLog) : null;
  const callerLabel =
    callerName ||
    (callLog?.caller_phone ? formatPhoneDisplay(callLog.caller_phone) : "Unknown caller");

  return (
    <DashboardShell active="Live Feed" navigate={navigate} path={path}>
      <header className="operational-header">
        <div className="detail-header-left">
          <button
            className="back-button"
            onClick={() => navigate("/live-feed")}
            aria-label="Back to Live Feed"
          >
            <Icon name="arrow_back" />
          </button>
          <div>
            <h1>Call detail</h1>
            <p>
              {loading
                ? "Loading…"
                : error
                  ? `Error: ${error}`
                  : callLog
                    ? `${callerLabel} · ${durationLabel}`
                    : "Call not found"}
            </p>
          </div>
        </div>
        {isLive ? (
          <div className="active-call-pill">
            <PulseBars small />
            <span>Live</span>
          </div>
        ) : (
          <div className="active-call-pill" style={{ opacity: 0.6 }}>
            <span>{callLog?.status ?? "ended"}</span>
          </div>
        )}
      </header>

      <section className="live-feed-grid">
        <article className="active-call-card">
          <div className="active-call-head">
            <div className="agent-identity">
              <div className="agent-avatar">B</div>
              <div>
                <strong>Bella (AI Agent)</strong>
                <span>{isLive ? `In call with ${callerLabel}` : callerLabel}</span>
              </div>
            </div>
            <time>{durationLabel}</time>
          </div>

          <div className="transcript-stream">
            {loading && <p style={{ color: "var(--on-surface-variant)", padding: 12 }}>Loading transcript…</p>}
            {!loading && messages.length === 0 && (
              <p style={{ color: "var(--outline)", padding: 12 }}>
                No transcript captured for this call.
              </p>
            )}
            {messages.map((message, index) => (
              <TranscriptBubble key={index} message={message} delay={index} />
            ))}
          </div>
        </article>

        <aside className="call-side-panel">
          <article className="live-card">
            <h2>Call metrics</h2>
            <div className="live-metric-grid">
              <div>
                <span>
                  <Icon name="speed" />
                  Latency
                </span>
                <strong>
                  {callLog?.latency_ms != null ? callLog.latency_ms : "—"} <small>ms</small>
                </strong>
              </div>
              <div>
                <span>
                  <Icon name="timer" />
                  Duration
                </span>
                <strong className="blue">{durationLabel}</strong>
              </div>
            </div>
            <div className="intent-row">
              <span>Intent</span>
              <div>
                <i />
              </div>
              <strong>{intentLabel}</strong>
            </div>
          </article>

          <article className="context-card">
            <h2>Outcome</h2>
            <div className="context-line" />
            <ContextItem
              icon="event_available"
              label="Booking outcome"
              value={outcome ? humanizeOutcome(outcome) : "—"}
            />
            <ContextItem
              icon="mood"
              label="Caller sentiment"
              value={sentiment ? capitalize(sentiment) : "—"}
            />
            <ContextItem
              icon="voicemail"
              label="Voicemail"
              value={callLog?.in_voicemail ? "Yes" : "No"}
            />
            {callLog?.special_requests && (
              <div className="context-note">
                <span>Special requests</span>
                <p>{callLog.special_requests}</p>
              </div>
            )}
            {callLog?.recording_url && (
              <div className="context-note">
                <span>Recording</span>
                <div className="context-note-audio">
                  <AudioPlayer src={callLog.recording_url} />
                </div>
              </div>
            )}
            {callLog?.summary && (
              <div className="context-note">
                <span>Summary</span>
                <p>{callLog.summary}</p>
              </div>
            )}
            {callLog?.reservation_id && (
              <button
                className="primary-action"
                style={{ marginTop: 16 }}
                onClick={() => navigate("/booking-log")}
              >
                <Icon name="check_circle" />
                View reservation
              </button>
            )}
          </article>
        </aside>
      </section>
    </DashboardShell>
  );
}


function AudioPlayer({ src }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onMeta = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
    };
    const onTime = () => setCurrentTime(audio.currentTime);
    const onEnd = () => {
      setPlaying(false);
      setCurrentTime(0);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onErr = () => setError(true);

    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("ended", onEnd);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("error", onErr);

    return () => {
      audio.pause();
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("ended", onEnd);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("error", onErr);
    };
  }, [src]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio || error) return;
    if (audio.paused) {
      audio.play().catch(() => setError(true));
    } else {
      audio.pause();
    }
  };

  const seek = (event) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
    setCurrentTime(audio.currentTime);
  };

  const fmt = (sec) => {
    if (!Number.isFinite(sec)) return "0:00";
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className={`audio-player${error ? " is-error" : ""}`}>
      <audio ref={audioRef} src={src} preload="metadata" />
      <button
        type="button"
        className="audio-play-btn"
        onClick={toggle}
        disabled={error}
        aria-label={playing ? "Pause recording" : "Play recording"}
      >
        <Icon name={error ? "error" : playing ? "pause" : "play_arrow"} />
      </button>
      <div className="audio-player-body">
        <div
          className="audio-progress"
          role="slider"
          aria-valuemin={0}
          aria-valuemax={Math.floor(duration)}
          aria-valuenow={Math.floor(currentTime)}
          aria-label="Seek"
          onClick={seek}
        >
          <div className="audio-progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="audio-times">
          <span>{fmt(currentTime)}</span>
          <span className="audio-times-sep">/</span>
          <span>{error ? "—" : fmt(duration)}</span>
        </div>
      </div>
      {error && <span className="audio-error-msg">Recording unavailable</span>}
    </div>
  );
}

function TranscriptBubble({ message, delay }) {
  const isAi = message.speaker === "ai";

  return (
    <div
      className={`transcript-row ${isAi ? "ai" : "guest"}`}
      style={{ animationDelay: `${delay * 80}ms` }}
    >
      <div className="speaker-dot">
        <Icon name={isAi ? "robot_2" : "person"} />
      </div>
      <div className="bubble-group">
        <div className="transcript-bubble">
          {message.text}
          {message.typing && (
            <span className="typing-dots">
              <i />
              <i />
              <i />
            </span>
          )}
        </div>
        {message.time && <time>{message.time}</time>}
      </div>
    </div>
  );
}

function PulseBars({ small = false }) {
  return (
    <div className={small ? "pulse-bars small" : "pulse-bars"} aria-hidden="true">
      {[14, 24, 18, 28, 16].map((height, index) => (
        <span key={`${height}-${index}`} style={{ height }} />
      ))}
    </div>
  );
}

function ContextItem({ icon, label, value }) {
  return (
    <div className="context-item">
      <span>{label}</span>
      <strong>
        <Icon name={icon} />
        {value}
      </strong>
    </div>
  );
}
