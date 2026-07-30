import { useEffect, useRef } from "react";

// Six-box one-time-code input. Controlled: `value` is the current digit string
// ("" to "dddddd"); `onChange` receives the new string; `onComplete` fires
// once when the sixth digit lands (auto-submit). Paste of a full code anywhere
// in the row fills every box. `disabled` freezes input while confirming;
// `error` drives the shake style from the parent.
const LENGTH = 6;

export function OtpInput({ value, onChange, onComplete, disabled = false, error = false }) {
  const refs = useRef([]);
  const completedFor = useRef(null);

  const digits = Array.from({ length: LENGTH }, (_, i) => value[i] ?? "");

  useEffect(() => {
    if (value.length === LENGTH && completedFor.current !== value) {
      completedFor.current = value;
      onComplete?.(value);
    }
    if (value.length < LENGTH) {
      completedFor.current = null;
    }
  }, [value, onComplete]);

  const focusBox = (i) => {
    const el = refs.current[Math.max(0, Math.min(LENGTH - 1, i))];
    el?.focus();
    el?.select?.();
  };

  const handleChange = (i, raw) => {
    const cleaned = raw.replace(/\D/g, "");
    if (!cleaned) return;
    // Multiple digits (paste, or fast typing into one box): fill from box i.
    const next = (value.slice(0, i) + cleaned).slice(0, LENGTH);
    onChange(next);
    focusBox(next.length >= LENGTH ? LENGTH - 1 : next.length);
  };

  const handleKeyDown = (i, e) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      if (digits[i]) {
        onChange(value.slice(0, i) + value.slice(i + 1));
      } else if (i > 0) {
        onChange(value.slice(0, i - 1) + value.slice(i));
        focusBox(i - 1);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusBox(i - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      focusBox(i + 1);
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const cleaned = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, LENGTH);
    if (!cleaned) return;
    onChange(cleaned);
    focusBox(cleaned.length >= LENGTH ? LENGTH - 1 : cleaned.length);
  };

  return (
    <div
      className={`otp-row${error ? " is-error" : ""}`}
      role="group"
      aria-label="6-digit verification code"
    >
      {digits.map((digit, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="otp-box"
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          pattern="[0-9]*"
          maxLength={LENGTH} /* allow a full paste/autofill to land in one box */
          value={digit}
          disabled={disabled}
          aria-label={`Digit ${i + 1}`}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}
