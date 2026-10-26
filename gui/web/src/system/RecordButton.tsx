import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { InlineConfirm } from "../ui";
import { BUSY_REASON, disabledAttrs } from "../ui/disabledReason";

/** How long the stop is held. The ring fills in this time. */
export const HOLD_TO_STOP_MS = 600;
const HINT_MS = 2000;
const STOP_PROMPT = "Stop this take? Recording ends for everyone in the room.";

export type RecordFace = "idle" | "live" | "paused";

const NAMES: Record<RecordFace, string> = {
  idle: "Record",
  live: "Stop take",
  paused: "Resume recording",
};

export type RecordButtonProps = {
  /** Idle starts a take, paused resumes it, live stops it on a hold. */
  face: RecordFace;
  /** A record command is in flight. */
  busy?: boolean;
  /** Why it cannot be pressed ("Waiting for Jon to join"). */
  disabledReason?: string;
  /** Idle: start. Paused: resume. */
  onStart: () => void;
  onStop: () => void;
};

const RING_RADIUS = 30;

/**
 * The one control that records. A record-red circle starts or resumes; while live
 * it is a square in a ring, and holding it stops the take as the ring fills.
 * Keyboard and assistive tech cannot hold, so Enter or Space asks first.
 */
export function RecordButton({
  face,
  busy = false,
  disabledReason,
  onStart,
  onStop,
}: RecordButtonProps) {
  const [holding, setHolding] = useState(false);
  const [hint, setHint] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const hintTimer = useRef<number | undefined>(undefined);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const [seenFace, setSeenFace] = useState(face);
  if (seenFace !== face) {
    setSeenFace(face);
    setHolding(false);
    setConfirming(false);
  }
  const hintId = useId();
  const reason = disabledReason ?? (busy ? BUSY_REASON : undefined);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(hintTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!confirming && returnFocus.current) {
      returnFocus.current = false;
      buttonRef.current?.focus();
    }
  }, [confirming]);

  const reasonRef = useRef(reason);
  useEffect(() => {
    reasonRef.current = reason;
  }, [reason]);

  useEffect(() => {
    if (face !== "live") {
      window.clearTimeout(timer.current);
    }
  }, [face]);

  function closeConfirm() {
    returnFocus.current = true;
    setConfirming(false);
  }

  function press(event: PointerEvent<HTMLButtonElement>) {
    if (
      face !== "live" ||
      reason !== undefined ||
      event.button !== 0 ||
      holding
    ) {
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setHint(false);
    setHolding(true);
    timer.current = window.setTimeout(() => {
      setHolding(false);
      if (reasonRef.current === undefined) {
        onStop();
      }
    }, HOLD_TO_STOP_MS);
  }

  function release() {
    if (!holding) {
      return;
    }
    window.clearTimeout(timer.current);
    setHolding(false);
    setHint(true);
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(false), HINT_MS);
  }

  function key(event: KeyboardEvent<HTMLButtonElement>) {
    if (face === "live" && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      if (reason === undefined) {
        setConfirming(true);
      }
    }
  }

  return (
    <span className="sys-record">
      <button
        ref={buttonRef}
        type="button"
        className="sys-record-btn"
        data-face={face}
        data-holding={holding || undefined}
        aria-label={NAMES[face]}
        aria-describedby={face === "live" ? hintId : undefined}
        onClick={face === "live" ? undefined : onStart}
        onPointerDown={press}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={key}
        onContextMenu={(event) => event.preventDefault()}
        {...disabledAttrs(reason)}
      >
        {face === "live" ? (
          <svg
            viewBox="0 0 64 64"
            className="sys-record-live"
            aria-hidden="true"
          >
            <circle
              className="sys-record-track"
              cx="32"
              cy="32"
              r={RING_RADIUS}
            />
            <circle
              className="sys-record-fill"
              cx="32"
              cy="32"
              r={RING_RADIUS}
              pathLength={1}
            />
            <rect
              className="sys-record-square"
              x="22"
              y="22"
              width="20"
              height="20"
              rx="4"
            />
          </svg>
        ) : (
          <span className="sys-record-dot" aria-hidden="true" />
        )}
      </button>
      {face === "live" ? (
        <span id={hintId} className="sys-record-hint" role="status">
          {hint ? "Hold to stop" : " "}
        </span>
      ) : null}
      {confirming ? (
        <div className="sys-record-confirm">
          <InlineConfirm
            prompt={STOP_PROMPT}
            keepLabel="Keep recording"
            actionLabel="Stop take"
            disabledReason={reason}
            onKeep={closeConfirm}
            onConfirm={() => {
              closeConfirm();
              if (reasonRef.current === undefined) {
                onStop();
              }
            }}
          />
        </div>
      ) : null}
    </span>
  );
}
