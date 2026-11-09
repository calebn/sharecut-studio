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

/** What a drag on a pill's edge may do: roll the seam, within the room the clips leave. */
export type SeamRoll = {
  /** The roll's reach in ms either way, read when a drag starts; null when the seam cannot roll. */
  limits: () => { minMs: number; maxMs: number } | null;
  /** One roll of `deltaMs`, saved on release. */
  onCommit: (deltaMs: number) => void;
};

/** Transcript density: a pixel of drag is 12.5 ms, and 1 ms with Alt held. */
export const SEAM_PX_PER_SEC = 80;
export const SEAM_FINE_SCALE = 12.5;
const SEAM_DRAG_THRESHOLD_PX = 4;

export type SeamProps = SeamFormProps & {
  /** Pill only: drag either edge to roll the seam, Alt with an arrow key to roll it 1 ms. */
  roll?: SeamRoll;
  selected?: boolean;
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

const readout = (ms: number) =>
  `${ms < 0 ? "−" : "+"}${Math.round(Math.abs(ms))} ms`;

function RollEdges({
  roll,
  onSelect,
  cancel,
}: {
  roll: SeamRoll;
  onSelect: () => void;
  /** Filled with the way to drop a roll in progress, for Escape on the pill. */
  cancel: { current: (() => boolean) | null };
}) {
  const [shown, setShown] = useState<number | null>(null);
  const drag = useRef<{
    id: number;
    originX: number;
    lastX: number;
    ms: number;
    moved: boolean;
    lo: number;
    hi: number;
  } | null>(null);
  const end = () => {
    drag.current = null;
    setShown(null);
  };
  cancel.current = () => {
    if (!drag.current) return false;
    end();
    return true;
  };
  const down = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0 || drag.current) return;
    const limits = roll.limits();
    if (!limits) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    // Escape reaches the pill, which holds focus while its edge is dragged.
    event.currentTarget.parentElement
      ?.querySelector<HTMLElement>(".sys-seam-hit")
      ?.focus({ preventScroll: true });
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
  const move = (event: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    if (
      !d.moved &&
      Math.abs(event.clientX - d.originX) < SEAM_DRAG_THRESHOLD_PX
    )
      return;
    d.moved = true;
    const scale = SEAM_PX_PER_SEC * (event.altKey ? SEAM_FINE_SCALE : 1);
    d.ms = Math.min(
      d.hi,
      Math.max(d.lo, d.ms + ((event.clientX - d.lastX) / scale) * 1000),
    );
    d.lastX = event.clientX;
    setShown(d.ms);
  };
  const up = (event: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    end();
    if (!d.moved) onSelect();
    else if (Math.round(d.ms) !== 0) roll.onCommit(Math.round(d.ms));
  };
  return (
    <>
      {(["left", "right"] as const).map((side) => (
        <span
          key={side}
          className="sys-seam-edge"
          data-side={side}
          aria-hidden="true"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={end}
        />
      ))}
      {shown !== null ? (
        <>
          <span className="sys-seam-readout" aria-hidden="true">
            {readout(shown)}
          </span>
          <span className="sr-only" role="status">
            {`Roll seam ${readout(shown)}`}
          </span>
        </>
      ) : null}
    </>
  );
}

export function Seam(props: SeamProps) {
  const { selected = false, onSelect, onKeyDown, tabIndex, roll } = props;
  const { open, id, anchor, setAnchor, handlers } =
    useHoverTip<HTMLButtonElement>();
  const wordsId = useId();
  const cancelRoll = useRef<(() => boolean) | null>(null);
  const diamond = props.form === "diamond";
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
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "Escape" && cancelRoll.current?.()) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (
            roll &&
            !diamond &&
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
              roll.onCommit(ms);
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
      {roll && !diamond ? (
        <RollEdges roll={roll} onSelect={onSelect} cancel={cancelRoll} />
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
