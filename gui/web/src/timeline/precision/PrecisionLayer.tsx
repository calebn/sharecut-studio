/**
 * The precision jog pad (#1184): when Auto chooses precision, the drawer's
 * place becomes a trackpad with a speed ladder.
 */
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { RippleMark } from "../../ui/RippleMark";
import {
  commitPrecision,
  PRECISION_UI_ATTR,
  type PrecisionView,
  precisionPad,
  precisionView,
  subscribePrecision,
  valueText,
} from "./precisionController";
import { deltaText, frameOf, JOG_GAINS } from "./precisionMath";

const ui = { [PRECISION_UI_ATTR]: "" };

const pad = {
  onPointerDown: (e: ReactPointerEvent) =>
    precisionPad.down(e.nativeEvent, e.currentTarget),
  onPointerMove: (e: ReactPointerEvent) => precisionPad.move(e.nativeEvent),
  onPointerUp: (e: ReactPointerEvent) => precisionPad.up(e.nativeEvent),
  onPointerCancel: (e: ReactPointerEvent) => precisionPad.up(e.nativeEvent),
};

function Readout({ v }: { v: PrecisionView }) {
  const ripples = v.field.kind === "trim";
  return (
    <div className="precision-readout">
      <span className="precision-name">{v.name}</span>
      <output
        className="precision-delta"
        data-bump={v.stop ? v.bump : undefined}
        key={v.stop ? v.bump : "free"}
      >
        {deltaText(v.field, v.origin, v.value)}
      </output>
      <span className="precision-value">{valueText(v.field, v.value)}</span>
      {ripples ? <RippleMark /> : null}
      {v.stop ? (
        <span className="precision-stop">
          {v.stop.kind === "boundary"
            ? `At ${v.stop.boundary.label}`
            : "At its limit"}
        </span>
      ) : null}
    </div>
  );
}

function DoneButton() {
  return (
    <button
      type="button"
      className="ui-control modifier-action primary precision-done"
      onClick={commitPrecision}
    >
      Done
    </button>
  );
}

function JogPad({ v }: { v: PrecisionView }) {
  const frame = frameOf(v.field);
  const steps = Math.round((v.value - v.origin) / frame);
  const ribOffset = `${(steps % 8) * 0.125}rem`;
  return (
    <section {...ui} className="precision-jog" aria-label={`${v.name} jog pad`}>
      <header className="precision-jog-head">
        <Readout v={v} />
        <DoneButton />
      </header>
      <div
        className="precision-jog-pad"
        data-dragging={v.dragging || undefined}
        style={{ "--precision-rib-offset": ribOffset } as CSSProperties}
        {...pad}
      >
        <span className="precision-jog-hint">
          {v.dragging ? JOG_GAINS[v.gain].label : "Drag here to move it"}
        </span>
        <ol className="precision-gain-ladder" aria-label="Speed">
          {[...JOG_GAINS].reverse().map((g, i) => {
            const index = JOG_GAINS.length - 1 - i;
            return (
              <li key={g.label} aria-current={index === v.gain || undefined}>
                {g.label}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

/** Renders the jog pad while a precision drag is active. */
export function PrecisionLayer() {
  const v = useSyncExternalStore(subscribePrecision, precisionView);
  const surface = v?.variant === "jog" ? <JogPad v={v} /> : null;
  return v
    ? createPortal(
        <div
          className="precision-layer"
          data-variant={v.variant}
          data-mode={v.decision.mode}
        >
          {surface}
        </div>,
        document.body,
      )
    : null;
}
