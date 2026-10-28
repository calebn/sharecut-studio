import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

export type TimeFieldProps = {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
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

/** One gesture is one change. */
export function TimeField({
  label,
  value,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  step = 1,
  format = plain,
  parse = parseNumber,
  onChange,
}: TimeFieldProps) {
  const [draft, setDraftState] = useState<string | null>(null);
  const typed = useRef<string | null>(null);
  const setDraft = (text: string | null) => {
    typed.current = text;
    setDraftState(text);
  };
  const drag = useRef<{ x: number; from: number } | null>(null);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const commit = (next: number) => {
    const clamped = clamp(next);
    if (clamped !== value) onChange(clamped);
  };
  const release = useEffectEvent(() => {
    const parsed = typed.current === null ? null : parse(typed.current);
    if (parsed !== null) commit(parsed);
  });
  useEffect(() => () => release(), []);
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
    </span>
  );
}
