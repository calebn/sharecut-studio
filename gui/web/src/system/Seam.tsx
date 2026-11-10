import {
  type KeyboardEvent,
  type PointerEvent,
  useId,
  useRef,
  useState,
} from "react";
import { HoverTip } from "./HoverTip";
import { SystemIcon } from "./SystemIcon";
import { useHoverTip } from "./useHoverTip";

type SeamKind = "cut" | "split";

type SeamFormProps =
  | {
      form: "diamond";
      kind: SeamKind;
      /** What the seam is, with its time: "Cut at 12:04.3". It names the button and heads the tip. */
      label: string;
      /** A second tip line: "2.4 s removed". */
      detail?: string;
    }
  | {
      form: "pill";
      /** The removed length, already formatted: "2.4 s". */
      removed: string;
      /** The words the cut took out, shown in the tip. */
      words?: string;
      /** The cut began in an earlier turn. The pill says so instead of repeating the length. */
      continued?: boolean;
      /** The cut runs on into the next turn. */
      continues?: boolean;
    };

/** What a drag on a seam may do: roll it, within the room the clips leave. */
export type SeamRoll = {
  /** The roll's reach in ms either way, read when a drag starts; null when the seam cannot roll. */
  limits: () => { minMs: number; maxMs: number } | null;
  /** One roll of `deltaMs`, saved on release. A promise keeps the preview up until the save settles. */
  onCommit: (deltaMs: number) => void | Promise<unknown>;
  /** Diamond only: the timeline's pixels per second, so the diamond follows the pointer. The pill rolls at the transcript's density. */
  pxPerSec?: number;
  /** The roll in progress in ms, or null when it ends. */
  onPreview?: (deltaMs: number | null) => void;
};

/** Transcript density: a pixel of drag is 12.5 ms, and 1 ms with Alt held. */
export const SEAM_PX_PER_SEC = 80;
export const SEAM_FINE_SCALE = 12.5;
const SEAM_DRAG_THRESHOLD_PX = 4;
const NO_ROLL: SeamRoll = { limits: () => null, onCommit: () => undefined };

export type SeamProps = SeamFormProps & {
  /** Drag a pill's either edge or the diamond itself to roll the seam, Alt with an arrow key to roll it 1 ms. */
  roll?: SeamRoll;
  selected?: boolean;
  /** Data attributes the host marks the button with, such as the timeline's hit-target props. */
  hit?: Readonly<Record<`data-${string}`, string>>;
  onSelect: () => void;
  /** For a host that moves focus among its marks, as the Script pane does among its words. */
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /** With `onKeyDown`, the roving tab stop: 0 for the one stop, -1 for the rest. Left out, the button is a tab stop of its own. */
  tabIndex?: number;
};

function pillName(props: Extract<SeamProps, { form: "pill" }>): string {
  if (props.continued) {
    return props.continues
      ? "Cut, continued from the previous turn and on into the next"
      : "Cut, continued from the previous turn";
  }
  return props.continues
    ? `Cut, ${props.removed} removed, continues in the next turn`
    : `Cut, ${props.removed} removed`;
}

const readout = (ms: number, stepMs: number) => {
  const digits = stepMs < 1 && Math.abs(ms) < 10 ? 1 : 0;
  return `${ms < 0 ? "−" : "+"}${Math.abs(ms).toFixed(digits)} ms`;
};

function useRollGesture(roll: SeamRoll, onTap?: () => void) {
  const [shown, setShown] = useState<number | null>(null);
  const stepMs = roll.pxPerSec ? 0.1 : 1;
  const drag = useRef<{
    id: number;
    originX: number;
    lastX: number;
    ms: number;
    moved: boolean;
    lo: number;
    hi: number;
  } | null>(null);
  const moved = useRef(false);
  const end = () => {
    drag.current = null;
    setShown(null);
    roll.onPreview?.(null);
  };
  const cancel = () => {
    if (!drag.current) return false;
    end();
    return true;
  };
  const down = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || drag.current) return;
    const limits = roll.limits();
    if (!limits) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget
      .closest(".sys-seam")
      ?.querySelector<HTMLElement>(".sys-seam-hit")
      ?.focus({ preventScroll: true });
    moved.current = false;
    drag.current = {
      id: event.pointerId,
      originX: event.clientX,
      lastX: event.clientX,
      ms: 0,
      moved: false,
      lo: limits.minMs,
      hi: limits.maxMs,
    };
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    if (
      !d.moved &&
      Math.abs(event.clientX - d.originX) < SEAM_DRAG_THRESHOLD_PX
    )
      return;
    d.moved = true;
    const scale =
      (roll.pxPerSec ?? SEAM_PX_PER_SEC) * (event.altKey ? SEAM_FINE_SCALE : 1);
    d.ms = Math.min(
      d.hi,
      Math.max(d.lo, d.ms + ((event.clientX - d.lastX) / scale) * 1000),
    );
    d.lastX = event.clientX;
    const rounded = Math.round(d.ms / stepMs) * stepMs;
    setShown(rounded);
    roll.onPreview?.(rounded);
  };
  const up = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    setShown(null);
    moved.current = d.moved;
    const ms = Math.round(d.ms / stepMs) * stepMs;
    if (!d.moved) {
      roll.onPreview?.(null);
      onTap?.();
    } else if (ms !== 0) {
      const saving = roll.onCommit(Math.round(ms * 10) / 10);
      void Promise.resolve(saving).finally(() => roll.onPreview?.(null));
    } else roll.onPreview?.(null);
  };
  const consumeMoved = () => {
    const was = moved.current;
    moved.current = false;
    return was;
  };
  return {
    shown,
    stepMs,
    cancel,
    consumeMoved,
    handlers: {
      onPointerDown: down,
      onPointerMove: move,
      onPointerUp: up,
      onPointerCancel: end,
    },
  };
}

function RollReadout({ ms, stepMs }: { ms: number; stepMs: number }) {
  return (
    <>
      <span className="sys-seam-readout" aria-hidden="true">
        {readout(ms, stepMs)}
      </span>
      <span className="sr-only" role="status">
        {`Roll seam ${readout(ms, stepMs)}`}
      </span>
    </>
  );
}

function RollEdges({
  gesture,
}: {
  gesture: ReturnType<typeof useRollGesture>;
}) {
  return (
    <>
      {(["left", "right"] as const).map((side) => (
        <span
          key={side}
          className="sys-seam-edge"
          data-side={side}
          aria-hidden="true"
          {...gesture.handlers}
        />
      ))}
    </>
  );
}

export function Seam(props: SeamProps) {
  const { selected = false, onSelect, onKeyDown, tabIndex, roll, hit } = props;
  const { open, id, anchor, setAnchor, handlers } =
    useHoverTip<HTMLButtonElement>();
  const wordsId = useId();
  const diamond = props.form === "diamond";
  const gesture = useRollGesture(
    roll ?? NO_ROLL,
    diamond ? undefined : onSelect,
  );
  const rollHandlers = diamond && roll ? gesture.handlers : undefined;
  const words = props.form === "pill" ? props.words : undefined;
  const name = diamond
    ? props.detail
      ? `${props.label}, ${props.detail}`
      : props.label
    : pillName(props);
  const hasTip = diamond || Boolean(props.words);
  return (
    <span
      className="sys-seam"
      data-form={props.form}
      data-kind={diamond ? props.kind : "cut"}
      {...handlers}
    >
      <button
        ref={setAnchor}
        type="button"
        className="sys-seam-hit"
        aria-label={name}
        aria-pressed={selected}
        aria-describedby={words ? wordsId : undefined}
        tabIndex={tabIndex}
        onClick={() => {
          if (!(diamond && gesture.consumeMoved())) onSelect();
        }}
        {...hit}
        onPointerDown={rollHandlers?.onPointerDown}
        onPointerMove={rollHandlers?.onPointerMove}
        onPointerUp={rollHandlers?.onPointerUp}
        onPointerCancel={rollHandlers?.onPointerCancel}
        onKeyDown={(event) => {
          if (event.key === "Escape" && gesture.cancel()) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (
            roll &&
            event.altKey &&
            !event.shiftKey &&
            (event.key === "ArrowLeft" || event.key === "ArrowRight")
          ) {
            event.preventDefault();
            // A held key would otherwise save and undo once per repeat.
            if (event.repeat) return;
            const limits = roll.limits();
            const ms = event.key === "ArrowLeft" ? -1 : 1;
            if (limits && ms >= limits.minMs && ms <= limits.maxMs)
              void roll.onCommit(ms);
            return;
          }
          onKeyDown?.(event);
        }}
      >
        {diamond ? (
          <span className="sys-seam-diamond" aria-hidden="true" />
        ) : (
          <>
            <SystemIcon name="scissors" size={12} />
            <span aria-hidden="true">
              {props.continued ? "continued" : props.removed}
            </span>
          </>
        )}
      </button>
      {roll && !diamond ? <RollEdges gesture={gesture} /> : null}
      {gesture.shown !== null ? (
        <RollReadout ms={gesture.shown} stepMs={gesture.stepMs} />
      ) : null}
      {words ? (
        <span id={wordsId} className="sr-only">
          {words}
        </span>
      ) : null}
      {hasTip && open && anchor ? (
        <HoverTip id={id} anchor={anchor}>
          {diamond ? (
            <>
              <span className="sys-tip-title">{props.label}</span>
              {props.detail ? (
                <span className="sys-tip-detail">{props.detail}</span>
              ) : null}
            </>
          ) : (
            <>
              <span className="sys-tip-title">
                {props.continued ? "Cut continued" : `Cut ${props.removed}`}
              </span>
              <span className="sys-tip-detail">{props.words}</span>
            </>
          )}
        </HoverTip>
      ) : null}
    </span>
  );
}
