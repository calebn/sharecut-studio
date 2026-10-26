import {
  type KeyboardEvent,
  type PointerEvent,
  useId,
  useRef,
  useState,
} from "react";

export type TimeFieldProps = {
  label: string;
  value: number;
  /** Shown after the value: "s", "dB". */
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** The value a reset dot returns to. No dot without it. */
  defaultValue?: number;
  format?: (value: number) => string;
  /** Null leaves the typed text rejected and the value unchanged. */
  parse?: (text: string) => number | null;
  onChange: (value: number) => void;
};

const plain = (value: number) => String(Math.round(value * 100) / 100);
const parseNumber = (text: string) => {
  const n = Number.parseFloat(text);
  return Number.isFinite(n) ? n : null;
};

/** Pixels of drag per step. */
const DRAG_PX = 4;

/** A number with its unit: drag, type, or step with the arrows. One gesture is one change. */
export function TimeField({
  label,
  value,
  unit,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  step = 1,
  defaultValue,
  format = plain,
  parse = parseNumber,
  onChange,
}: TimeFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const drag = useRef<{ x: number; from: number } | null>(null);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const commit = (next: number) => {
    const clamped = clamp(next);
    if (clamped !== value) onChange(clamped);
  };
  const multiplier = (event: { shiftKey: boolean; altKey: boolean }) =>
    event.shiftKey ? 10 : event.altKey ? 0.1 : 1;

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const sign = event.key === "ArrowUp" ? 1 : -1;
      commit(value + sign * step * multiplier(event));
      setDraft(null);
    } else if (event.key === "Enter") {
      const parsed = draft === null ? null : parse(draft);
      if (parsed !== null) commit(parsed);
      setDraft(null);
    } else if (event.key === "Escape") {
      setDraft(null);
    }
  };

  const onDown = (event: PointerEvent<HTMLElement>) => {
    drag.current = { x: event.clientX, from: value };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onMove = (event: PointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start) return;
    const steps = Math.round((event.clientX - start.x) / DRAG_PX);
    commit(start.from + steps * step * multiplier(event));
  };
  const onUp = () => {
    drag.current = null;
  };

  return (
    <span className="sys-time">
      <span
        className="sys-time-grip"
        aria-hidden="true"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {label}
      </span>
      <input
        id={id}
        className="sys-time-input sys-mono"
        aria-label={label}
        inputMode="decimal"
        value={draft ?? format(value)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const parsed = draft === null ? null : parse(draft);
          if (parsed !== null) commit(parsed);
          setDraft(null);
        }}
        onKeyDown={onKey}
      />
      {unit ? <span className="sys-time-unit">{unit}</span> : null}
      {defaultValue !== undefined && value !== defaultValue ? (
        <button
          type="button"
          className="sys-time-reset"
          aria-label={`Reset ${label}`}
          title={`Reset ${label}`}
          onClick={() => onChange(defaultValue)}
        />
      ) : null}
    </span>
  );
}
