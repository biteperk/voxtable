import { useEffect, useRef, useState } from "react";

/**
 * The service line — tonight's real numbers, set in mono.
 *
 * Mono is not styling here. Every operational surface in a venue is monospaced:
 * the POS, the docket printer, the kitchen rail. Numbers get mono, language gets
 * Inter. That split is drawn from the operator's world rather than imposed.
 *
 * Figures the caller's role may not see arrive as `undefined` and are simply not
 * rendered — a server sees three cells instead of four, never an error.
 */

/** Count up once on load, because the numbers are real and arriving. */
function useCountUp(target, enabled) {
  const [value, setValue] = useState(enabled ? 0 : target);
  const frame = useRef(0);

  useEffect(() => {
    if (!enabled || typeof target !== "number" || target === 0) {
      setValue(target ?? 0);
      return undefined;
    }
    const start = performance.now();
    const DURATION = 420;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / DURATION);
      // Ease-out: fast arrival, gentle settle. Matches --ease-out elsewhere.
      setValue(Math.round(target * (1 - Math.pow(1 - t, 3))));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [target, enabled]);

  return value;
}

function Figure({ value, label, hint }) {
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const shown = useCountUp(value, !reduced);

  return (
    <div className="service-figure">
      <span className="service-figure-value">{shown}</span>
      <span className="service-figure-label">{label}</span>
      {hint ? <span className="service-figure-hint">{hint}</span> : null}
    </div>
  );
}

export function ServiceLine({ venueName, service, localTime, loading }) {
  if (loading) {
    return (
      <section className="service-line is-loading" aria-busy="true">
        <div className="service-line-head">
          <span className="service-line-title">Tonight</span>
        </div>
        <p className="service-line-empty">Checking tonight's service…</p>
      </section>
    );
  }

  const figures = [
    service.covers_booked !== undefined && {
      key: "covers",
      value: service.covers_booked,
      label: service.covers_booked === 1 ? "cover booked" : "covers booked",
      hint: service.next_booking_time ? `next at ${service.next_booking_time}` : null
    },
    service.orders_waiting !== undefined && {
      key: "orders",
      value: service.orders_waiting,
      label: service.orders_waiting === 1 ? "order waiting" : "orders waiting"
    },
    service.calls_answered !== undefined && {
      key: "calls",
      value: service.calls_answered,
      label: service.calls_answered === 1 ? "call answered" : "calls answered"
    }
  ].filter(Boolean);

  return (
    <section className="service-line" aria-label={`Tonight at ${venueName}`}>
      <div className="service-line-head">
        <span className="service-line-title">
          Tonight <span className="service-line-venue">· {venueName}</span>
        </span>
        <span className="service-line-clock">{localTime}</span>
      </div>
      <div className="service-line-figures">
        {figures.map((f) => (
          <Figure key={f.key} value={f.value} label={f.label} hint={f.hint} />
        ))}
      </div>
    </section>
  );
}
