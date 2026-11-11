import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { isHandleDrag } from "../edit/dragThreshold";
import { DOUBLE_TAP_MS, TOUCH_SLOP_PX } from "../hooks/gestureConstants";
import {
  clamp,
  factorScale,
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
  /** What the empty state reads; "Mixed" for a field whose values differ across a selection. */
  emptyText?: string;
  /** Value change per pixel of drag and per arrow press. */
  step?: number;
  /**
   * `step` is a factor, not an increment: an arrow press multiplies (or
   * divides) by it and a drag changes the value by a factor of `step` per
   * eight pixels, as the zoom steps do; Shift covers three factors at once. Needs a positive `min`.
   */
  multiplicative?: boolean;
  /** Pixels of drag per additive step, for a coarse whole-number field (default 1). */
  pixelsPerStep?: number;
  /** Alt gives a tenth of the step, so a whole-number field that wants Alt needs one more place. */
  decimals?: number;
  /** Reset target shown by the dot and, for level fields, a double activation. */
  defaultValue?: number;
  readOnly?: boolean;
  /** A message from outside, such as a rejected value. Typing a bad number sets its own. */
  error?: string;
  /** The id of text that explains the whole field, such as why it is read-only. */
  describedBy?: string;
  /** Fires while a drag moves, for the live preview on the canvas. */
  onPreview?: (value: number) => void;
  /** Fires once per gesture, so one drag, key press or typed value is one undo step. */
  onCommit: (value: number) => void;
  skipUnchanged?: boolean;
  commitUnchanged?: boolean;
  /** Refuses a typed number with a fraction instead of rounding it. */
  integerOnly?: boolean;
  /** Moves a dragged value to a nearby mark. Arrow keys and typed values are not snapped. */
  snap?: (value: number) => number;
  /** Commits a valid typed value still open when the field goes away, as Enter would. */
  commitOnUnmount?: boolean;
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

type LevelResetSequence = {
  kind: "mouse" | "touch";
  at: number;
  x: number;
  y: number;
  draft: string;
  second: {
    pointerId: number;
    x: number;
    y: number;
    phase: "pressed" | "released";
  } | null;
};

const EMPTY_TEXT = "Not set";
/** Pixels of drag that make one multiplicative step. */
const DRAG_PX_PER_STEP = 8;

export function ScrubField({
  label,
  value,
  unit,
  emptyText = EMPTY_TEXT,
  step = 1,
  multiplicative = false,
  pixelsPerStep = 1,
  decimals = multiplicative ? 2 : placesOf(step),
  defaultValue,
  readOnly = false,
  error,
  describedBy: describedByProp,
  onPreview,
  onCommit,
  onCancel,
  skipUnchanged = false,
  commitUnchanged = false,
  integerOnly = false,
  snap,
  commitOnUnmount = false,
  variant = "plain",
  min,
  max,
}: ScrubFieldProps) {
  const grid = 10 ** decimals;
  const bounds = {
    min:
      min === undefined ? undefined : Math.ceil(min * grid - 1e-9) / grid || 0,
    max:
      max === undefined ? undefined : Math.floor(max * grid + 1e-9) / grid || 0,
  };
  const errorId = useId();
  const box = useRef<HTMLSpanElement>(null);
  const drag = useRef<Drag | null>(null);
  const levelReset = useRef<LevelResetSequence | null>(null);
  const draftRef = useRef<string | null>(null);
  const openedText = useRef<string | null>(null);
  const refocus = useRef(false);
  const latestCancel = useRef(onCancel);
  const [rejected, setRejected] = useState(false);
  const [draft, setDraftState] = useState<string | null>(null);
  const setDraft = (next: string | null) => {
    if (draftRef.current === null) openedText.current = next;
    draftRef.current = next;
    if (next === null) setRejected(false);
    setDraftState(next);
  };

  const clearLevelReset = () => {
    levelReset.current = null;
  };

  const canResetLevel = () =>
    variant === "level" &&
    value !== null &&
    !readOnly &&
    defaultValue !== undefined;

  const commitLevelDefault = () => {
    const next = defaultValue;
    levelReset.current = null;
    if (!canResetLevel() || next === undefined) return;
    draftRef.current = null;
    setDraft(null);
    refocus.current = true;
    if (value !== next) onCommit(next);
  };

  const resetLevelGesture = () => {
    const sequence = levelReset.current;
    if (!sequence || draftRef.current !== sequence.draft) {
      clearLevelReset();
      return;
    }
    commitLevelDefault();
  };

  const pointIsNear = (
    x: number,
    y: number,
    originX: number,
    originY: number,
  ) => Math.hypot(x - originX, y - originY) <= TOUCH_SLOP_PX;

  useEffect(() => {
    latestCancel.current = onCancel;
  });

  const resolveDraft = (text: string) => {
    const parsed = parseScrub(text, unit);
    if (
      parsed === null ||
      !inBounds(parsed, bounds) ||
      (integerOnly && !Number.isInteger(parsed))
    )
      return null;
    return clamp(roundTo(parsed, decimals), bounds);
  };

  const flushDraft = useRef(() => {});
  useEffect(() => {
    flushDraft.current = () => {
      const text = draftRef.current;
      if (!commitOnUnmount || text === null) return;
      if (skipUnchanged && text === openedText.current) return;
      const next = resolveDraft(text);
      if (next !== null && next !== value) onCommit(next);
    };
  });

  useEffect(
    () => () => {
      flushDraft.current();
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
  const fractional = integerOnly && typed !== null && !Number.isInteger(typed);
  const typedError =
    draft !== null && (typed === null || !inBounds(typed, bounds) || fractional)
      ? fractional && typed !== null && inBounds(typed, bounds)
        ? "Enter a whole number"
        : rangeHint(bounds, unit)
      : undefined;
  const message = error ?? typedError;

  const cancelDrag = () => {
    if (!drag.current) return;
    const { active } = drag.current;
    drag.current = null;
    clearLevelReset();
    if (active) onCancel?.();
  };

  const onPointerDown = (event: PointerEvent<HTMLSpanElement>) => {
    clearLevelReset();
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
      clearLevelReset();
      gesture.lastX = event.clientX;
      return;
    }
    const dx = event.clientX - gesture.lastX;
    gesture.raw = clamp(
      multiplicative
        ? gesture.raw * step ** ((dx * factorScale(event)) / DRAG_PX_PER_STEP)
        : gesture.raw + (dx * modifierScale(event) * step) / pixelsPerStep,
      bounds,
    );
    gesture.lastX = event.clientX;
    const rounded = roundTo(gesture.raw, decimals);
    const next = snap
      ? clamp(roundTo(snap(rounded), decimals), bounds)
      : rounded;
    if (next === gesture.current) return;
    gesture.current = next;
    onPreview?.(next);
  };

  const onPointerUp = (event: PointerEvent<HTMLSpanElement>) => {
    const gesture = drag.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    drag.current = null;
    if (!gesture.active) {
      const nextDraft = value === null ? "" : formatScrub(value, decimals);
      if (
        canResetLevel() &&
        event.isPrimary !== false &&
        (event.pointerType === "mouse" || event.pointerType === "touch")
      ) {
        const activation = {
          at: Date.now(),
          x: event.clientX,
          y: event.clientY,
          draft: nextDraft,
        };
        levelReset.current = {
          kind: event.pointerType,
          ...activation,
          second: null,
        };
      } else {
        clearLevelReset();
      }
      setDraft(nextDraft);
      return;
    }
    if (gesture.current === roundTo(gesture.start ?? base, decimals))
      onCancel?.();
    else onCommit(gesture.current);
  };

  const onEditingPointerDown = (event: PointerEvent<HTMLSpanElement>) => {
    const sequence = levelReset.current;
    if (!sequence) return;
    if (
      !canResetLevel() ||
      draftRef.current !== sequence.draft ||
      (sequence.kind === "touch" && Date.now() - sequence.at >= DOUBLE_TAP_MS)
    ) {
      clearLevelReset();
      return;
    }
    if (
      event.pointerType !== sequence.kind ||
      event.isPrimary === false ||
      event.button !== 0 ||
      sequence.second !== null ||
      (sequence.kind === "touch" &&
        !pointIsNear(event.clientX, event.clientY, sequence.x, sequence.y))
    ) {
      clearLevelReset();
      return;
    }
    sequence.second = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      phase: "pressed",
    };
    if (sequence.kind === "touch") {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
  };

  const onEditingPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    const sequence = levelReset.current;
    const second = sequence?.second;
    if (!sequence || second?.pointerId !== event.pointerId) return;
    const moved =
      sequence.kind === "touch"
        ? !pointIsNear(event.clientX, event.clientY, second.x, second.y)
        : isHandleDrag(second.x, event.clientX);
    if (moved) clearLevelReset();
  };

  const onEditingPointerUp = (event: PointerEvent<HTMLSpanElement>) => {
    const sequence = levelReset.current;
    if (sequence?.second?.pointerId !== event.pointerId) return;
    const second = sequence.second;
    if (sequence.kind === "mouse") {
      if (event.button === 0 && event.isPrimary !== false)
        second.phase = "released";
      else clearLevelReset();
      return;
    }
    if (
      Date.now() - sequence.at >= DOUBLE_TAP_MS ||
      event.isPrimary === false ||
      event.button !== 0 ||
      !pointIsNear(event.clientX, event.clientY, second.x, second.y) ||
      draftRef.current !== sequence.draft
    ) {
      clearLevelReset();
      return;
    }
    resetLevelGesture();
  };

  const onEditingPointerCancel = () => clearLevelReset();

  const onEditingLostPointerCapture = (
    event: PointerEvent<HTMLSpanElement>,
  ) => {
    const sequence = levelReset.current;
    if (sequence?.second?.pointerId === event.pointerId) clearLevelReset();
    const gesture = drag.current;
    if (gesture?.pointerId === event.pointerId) cancelDrag();
  };

  const onEditingMouseDown = (event: ReactMouseEvent<HTMLSpanElement>) => {
    const sequence = levelReset.current;
    if (!sequence) return;
    if (
      !canResetLevel() ||
      draftRef.current !== sequence.draft ||
      (sequence.kind === "touch" && Date.now() - sequence.at >= DOUBLE_TAP_MS)
    ) {
      clearLevelReset();
      return;
    }
    if (sequence.kind === "mouse") {
      if (event.detail === 2) event.preventDefault();
      else clearLevelReset();
      return;
    }
    event.preventDefault();
  };

  const onEditingDoubleClick = (event: ReactMouseEvent<HTMLSpanElement>) => {
    const sequence = levelReset.current;
    if (sequence?.kind !== "mouse") return;
    if (
      event.detail !== 2 ||
      sequence.second?.phase !== "released" ||
      !canResetLevel() ||
      draftRef.current !== sequence.draft
    ) {
      clearLevelReset();
      return;
    }
    event.preventDefault();
    resetLevelGesture();
  };

  const commitStep = (next: number) => {
    if (next !== value) onCommit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    clearLevelReset();
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
      // A held key would otherwise save and undo once per repeat.
      if (event.repeat) return;
      commitStep(
        multiplicative
          ? clamp(
              roundTo(
                base * step ** (direction * factorScale(event)),
                decimals,
              ),
              bounds,
            )
          : steppedValue(base, direction, step, event, decimals, bounds),
      );
    } else if (event.key === "Home" && min !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      commitStep(bounds.min ?? min);
    } else if (event.key === "End" && max !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      commitStep(bounds.max ?? max);
    } else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      event.stopPropagation();
      setDraft(value === null ? "" : formatScrub(value, decimals));
    }
  };

  const finishEdit = (how: "enter" | "escape" | "blur") => {
    const text = draftRef.current;
    if (text === null) return;
    const next = resolveDraft(text);
    if (how === "enter" && next === null) {
      setRejected(true);
      return;
    }
    refocus.current = how !== "blur";
    setDraft(null);
    if (how === "escape" || next === null) return;
    if (skipUnchanged && text === openedText.current) return;
    if (next !== value || (commitUnchanged && how === "enter")) onCommit(next);
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    clearLevelReset();
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
  const shown = value === null ? emptyText : formatScrub(value, decimals);
  const showReset =
    !readOnly &&
    (value !== null || variant === "level") &&
    defaultValue !== undefined &&
    value !== defaultValue;
  const editingContents = (
    <>
      <ScrubInput
        label={label}
        draft={draft ?? ""}
        invalid={message !== undefined}
        describedBy={message ? errorId : undefined}
        onChange={(text) => {
          clearLevelReset();
          setRejected(false);
          setDraft(text);
        }}
        onKeyDown={onInputKeyDown}
        onBlur={() => {
          clearLevelReset();
          finishEdit("blur");
        }}
      />
      {unit ? <span className="sys-scrub-unit">{unit}</span> : null}
    </>
  );
  const editingBox =
    variant === "level" ? (
      <span
        ref={box}
        className="sys-scrub-box"
        data-editing="true"
        role="presentation"
        onPointerDown={onEditingPointerDown}
        onPointerMove={onEditingPointerMove}
        onPointerUp={onEditingPointerUp}
        onPointerCancel={onEditingPointerCancel}
        onLostPointerCapture={onEditingLostPointerCapture}
        onMouseDown={onEditingMouseDown}
        onDoubleClick={onEditingDoubleClick}
      >
        {editingContents}
      </span>
    ) : (
      <span ref={box} className="sys-scrub-box" data-editing="true">
        {editingContents}
      </span>
    );

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
            aria-valuetext={value === null ? emptyText : `${shown}${unitText}`}
            aria-readonly={readOnly || undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={
              [error ? errorId : null, describedByProp]
                .filter(Boolean)
                .join(" ") || undefined
            }
            data-empty={value === null || undefined}
            data-readonly={readOnly || undefined}
            style={{ "--sys-scrub-ratio": ratio } as CSSProperties}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              clearLevelReset();
              cancelDrag();
            }}
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
          editingBox
        )}
        {showReset ? (
          <button
            type="button"
            className="sys-scrub-reset"
            aria-label={`Reset ${label} to ${formatScrub(defaultValue, decimals)}${unitText}`}
            onPointerDown={(event) => {
              if (
                variant === "level" &&
                box.current?.contains(document.activeElement)
              )
                event.preventDefault();
            }}
            onMouseDown={(event) => {
              if (
                variant === "level" &&
                box.current?.contains(document.activeElement)
              )
                event.preventDefault();
            }}
            onClick={() => {
              if (variant === "level" && value !== null) commitLevelDefault();
              else onCommit(defaultValue);
              box.current?.focus();
            }}
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
