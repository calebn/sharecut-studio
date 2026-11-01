import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { isHandleDrag } from "../edit/dragThreshold";
import {
  clamp,
  fillRatio,
  formatScrub,
  inBounds,
  modifierScale,
  parseScrub,
  placesOf,
  rangeHint,
  roundTo,
  steppedValue,
} from "./scrubMath";

type ScrubRange =
  | { variant?: "plain"; min?: number; max?: number }
  | { variant: "track" | "level"; min: number; max: number };

export type ScrubFieldProps = ScrubRange & {
  /** Names the field for assistive tech; the row around it shows the visible label. */
  label: string;
  /** Null draws the empty state and the field starts from the default, the minimum or zero. */
  value: number | null;
  unit?: string;
  /** Value change per pixel of drag and per arrow press. */
  step?: number;
  /** Alt gives a tenth of the step, so a whole-number field that wants Alt needs one more place. */
  decimals?: number;
  /** Shows the reset dot while the value differs from it. */
  defaultValue?: number;
  readOnly?: boolean;
  /** A message from outside, such as a rejected value. Typing a bad number sets its own. */
  error?: string;
  /** Fires while a drag moves, for the live preview on the canvas. */
  onPreview?: (value: number) => void;
  /** Fires once per gesture, so one drag, key press or typed value is one undo step. */
  onCommit: (value: number) => void;
  /** A drag ended where it began, or Escape: drop the preview. */
  onCancel?: () => void;
};

type Drag = {
  pointerId: number;
  originX: number;
  lastX: number;
  start: number | null;
  raw: number;
  current: number;
  active: boolean;
};

const EMPTY_TEXT = "Not set";

export function ScrubField({
  label,
  value,
  unit,
  step = 1,
  decimals = placesOf(step),
  defaultValue,
  readOnly = false,
  error,
  onPreview,
  onCommit,
  onCancel,
  variant = "plain",
  min,
  max,
}: ScrubFieldProps) {
  const bounds = { min, max };
  const errorId = useId();
  const box = useRef<HTMLSpanElement>(null);
  const drag = useRef<Drag | null>(null);
  const draftRef = useRef<string | null>(null);
  const refocus = useRef(false);
  const latestCancel = useRef(onCancel);
  const [rejected, setRejected] = useState(false);
  const [draft, setDraftState] = useState<string | null>(null);
  const setDraft = (next: string | null) => {
    draftRef.current = next;
    if (next === null) setRejected(false);
    setDraftState(next);
  };

  useEffect(() => {
    latestCancel.current = onCancel;
  });

  useEffect(
    () => () => {
      if (drag.current?.active) latestCancel.current?.();
      drag.current = null;
    },
    [],
  );

  useEffect(() => {
    if (draft === null && refocus.current) {
      refocus.current = false;
      box.current?.focus();
    }
  }, [draft]);

  const base = value ?? defaultValue ?? min ?? 0;
  const unitText = unit ? ` ${unit}` : "";
  const typed = draft === null ? null : parseScrub(draft, unit);
  const typedError =
    draft !== null && (typed === null || !inBounds(typed, bounds))
      ? rangeHint(bounds, unit)
      : undefined;
  const message = error ?? typedError;

  const cancelDrag = () => {
    if (!drag.current) return;
    const { active } = drag.current;
    drag.current = null;
    if (active) onCancel?.();
  };

  const onPointerDown = (event: PointerEvent<HTMLSpanElement>) => {
    if (readOnly || event.button !== 0 || drag.current) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      lastX: event.clientX,
      start: value,
      raw: base,
      current: base,
      active: false,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    const gesture = drag.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (!gesture.active) {
      if (!isHandleDrag(gesture.originX, event.clientX)) return;
      gesture.active = true;
      gesture.lastX = event.clientX;
      return;
    }
    gesture.raw = clamp(
      gesture.raw +
        (event.clientX - gesture.lastX) * step * modifierScale(event),
      bounds,
    );
    gesture.lastX = event.clientX;
    const next = roundTo(gesture.raw, decimals);
    if (next === gesture.current) return;
    gesture.current = next;
    onPreview?.(next);
  };

  const onPointerUp = (event: PointerEvent<HTMLSpanElement>) => {
    const gesture = drag.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    drag.current = null;
    if (!gesture.active) {
      setDraft(value === null ? "" : formatScrub(value, decimals));
      return;
    }
    if (gesture.current === roundTo(gesture.start ?? base, decimals))
      onCancel?.();
    else onCommit(gesture.current);
  };

  const commitStep = (next: number) => {
    if (next !== value) onCommit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Escape") {
      if (drag.current?.active) {
        event.preventDefault();
        event.stopPropagation();
        cancelDrag();
      }
      return;
    }
    if (readOnly) return;
    const direction =
      event.key === "ArrowUp" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowDown" || event.key === "ArrowLeft"
          ? -1
          : null;
    if (direction !== null) {
      event.preventDefault();
      event.stopPropagation();
      commitStep(steppedValue(base, direction, step, event, decimals, bounds));
    } else if (event.key === "Home" && min !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      commitStep(min);
    } else if (event.key === "End" && max !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      commitStep(max);
    } else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      event.stopPropagation();
      setDraft(value === null ? "" : formatScrub(value, decimals));
    }
  };

  const finishEdit = (how: "enter" | "escape" | "blur") => {
    const text = draftRef.current;
    if (text === null) return;
    const parsed = parseScrub(text, unit);
    const valid = parsed !== null && inBounds(parsed, bounds);
    if (how === "enter" && !valid) {
      setRejected(true);
      return;
    }
    refocus.current = how !== "blur";
    setDraft(null);
    if (how === "escape" || parsed === null || !valid) return;
    if (text === (value === null ? "" : formatScrub(value, decimals))) return;
    const next = clamp(roundTo(parsed, decimals), bounds);
    if (next !== value) onCommit(next);
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finishEdit("enter");
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finishEdit("escape");
    }
  };

  const ratio =
    variant !== "plain" && value !== null
      ? fillRatio(value, { min: min ?? 0, max: max ?? 0 })
      : 0;
  const shown = value === null ? EMPTY_TEXT : formatScrub(value, decimals);
  const showReset =
    !readOnly &&
    value !== null &&
    defaultValue !== undefined &&
    value !== defaultValue;

  return (
    <span className="sys-scrub" data-variant={variant}>
      <span className="sys-scrub-row">
        {draft === null ? (
          <span
            ref={box}
            className="sys-scrub-box"
            role="spinbutton"
            tabIndex={0}
            aria-label={label}
            aria-valuenow={value ?? undefined}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuetext={value === null ? EMPTY_TEXT : `${shown}${unitText}`}
            aria-readonly={readOnly || undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            data-empty={value === null || undefined}
            data-readonly={readOnly || undefined}
            style={{ "--sys-scrub-ratio": ratio } as CSSProperties}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={cancelDrag}
            onLostPointerCapture={cancelDrag}
            onKeyDown={onKeyDown}
          >
            {variant === "level" ? (
              <span className="sys-scrub-fill" aria-hidden="true" />
            ) : null}
            <span className="sys-scrub-value">{shown}</span>
            {unit && value !== null ? (
              <span className="sys-scrub-unit">{unit}</span>
            ) : null}
            {variant === "track" ? (
              <span className="sys-scrub-rail" aria-hidden="true">
                <span className="sys-scrub-thumb" />
              </span>
            ) : null}
          </span>
        ) : (
          <span className="sys-scrub-box" data-editing="true">
            <ScrubInput
              label={label}
              draft={draft}
              invalid={message !== undefined}
              describedBy={message ? errorId : undefined}
              onChange={(text) => {
                setRejected(false);
                setDraft(text);
              }}
              onKeyDown={onInputKeyDown}
              onBlur={() => finishEdit("blur")}
            />
            {unit ? <span className="sys-scrub-unit">{unit}</span> : null}
          </span>
        )}
        {showReset ? (
          <button
            type="button"
            className="sys-scrub-reset"
            aria-label={`Reset ${label} to ${formatScrub(defaultValue, decimals)}${unitText}`}
            onClick={() => onCommit(defaultValue)}
          />
        ) : null}
      </span>
      {message ? (
        <span
          id={errorId}
          className="sys-scrub-error"
          role={error || rejected ? "alert" : undefined}
        >
          {message}
        </span>
      ) : null}
    </span>
  );
}

type ScrubInputProps = {
  label: string;
  draft: string;
  invalid: boolean;
  describedBy?: string;
  onChange: (text: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onBlur: () => void;
};

function ScrubInput({
  label,
  draft,
  invalid,
  describedBy,
  onChange,
  onKeyDown,
  onBlur,
}: ScrubInputProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <input
      ref={input}
      className="sys-scrub-input"
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      value={draft}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    />
  );
}
