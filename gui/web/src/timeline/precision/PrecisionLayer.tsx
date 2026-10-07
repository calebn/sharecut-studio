/**
 * The precision drag's surface (#1184), one per variant:
 * - Jog pad: the drawer's place becomes a trackpad with a speed ladder.
 * - Auto-zoom lens: a frame over the zoomed lanes that takes the finger.
 * - Offset grip: a loupe above the finger, leading down to the edge.
 * Each shows the target's name, how far it moved, and the stop it is held
 * at, and offers Done (the jog and the lens; the grip finishes on lift).
 */
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useDawStore } from "../../state/dawStore";
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
import { deltaText, frameOf, JOG_GAINS, unitsPerSec } from "./precisionMath";

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
  // The ribs slide with the value, so a fine gain visibly moves less.
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

function visibleBox(el: Element | null) {
  const box = el?.getBoundingClientRect();
  return box
    ? { top: box.top, left: box.left, width: box.width, height: box.height }
    : null;
}

function Lens({ v }: { v: PrecisionView }) {
  const [box, setBox] = useState<ReturnType<typeof visibleBox>>(null);
  useLayoutEffect(() => {
    const place = () =>
      setBox(visibleBox(v.element.closest(".timeline-scroll")));
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [v.element]);
  if (!box) return null;
  return (
    <section
      {...ui}
      className="precision-lens"
      aria-label={`${v.name} lens`}
      style={box}
      {...pad}
    >
      <span className="precision-lens-hint">
        {v.dragging ? "Lift to finish" : "Drag anywhere to move it"}
      </span>
      <div className="precision-lens-bar">
        <Readout v={v} />
        <DoneButton />
      </div>
    </section>
  );
}

/** The loupe canvas size and how far above the finger it floats, CSS px. */
const LOUPE = { width: 224, height: 56, lift: 44 };

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}

function drawLoupe(canvas: HTMLCanvasElement, v: PrecisionView, zoom: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = LOUPE.width * dpr;
  canvas.height = LOUPE.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, LOUPE.width, LOUPE.height);
  const edge = v.element.getBoundingClientRect();
  const edgeX = edge.left + edge.width / 2;
  const lane = v.element.closest("[data-track-id]");
  const laneBox = lane?.getBoundingClientRect();
  const scale = v.pxPerSec / Math.max(zoom, 1e-6);
  if (lane && laneBox) {
    const srcW = LOUPE.width / scale;
    const x0 = edgeX - srcW / 2;
    ctx.imageSmoothingEnabled = true;
    for (const tile of lane.querySelectorAll("canvas")) {
      const r = tile.getBoundingClientRect();
      const left = Math.max(r.left, x0);
      const right = Math.min(r.right, x0 + srcW);
      if (right <= left || r.width <= 0 || r.height <= 0) continue;
      const kx = tile.width / r.width;
      ctx.drawImage(
        tile,
        (left - r.left) * kx,
        0,
        (right - left) * kx,
        tile.height,
        (left - x0) * scale,
        0,
        (right - left) * scale,
        LOUPE.height,
      );
    }
  }
  // Ticks every 10 ms (5 ms for a fade's 1 ms steps would crowd), taller at
  // 100 ms, counted from where the target was armed.
  const secPerUnit = 1 / Math.abs(unitsPerSec(v.field));
  const moved =
    (v.value - v.origin) * secPerUnit * Math.sign(unitsPerSec(v.field));
  const tickSec = Math.max(frameOf(v.field) * secPerUnit, 0.01);
  const mid = LOUPE.width / 2;
  const first = Math.ceil((moved - mid / v.pxPerSec) / tickSec);
  const last = Math.floor((moved + mid / v.pxPerSec) / tickSec);
  ctx.strokeStyle = cssVar("--text-dim");
  ctx.lineWidth = 1;
  for (let k = first; k <= last; k += 1) {
    const x = mid + (k * tickSec - moved) * v.pxPerSec;
    const major = k % 10 === 0;
    ctx.globalAlpha = k === 0 ? 1 : major ? 0.8 : 0.35;
    ctx.beginPath();
    ctx.moveTo(x, LOUPE.height);
    ctx.lineTo(x, LOUPE.height - (k === 0 ? 20 : major ? 12 : 6));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = cssVar("--accent");
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(mid, 0);
  ctx.lineTo(mid, LOUPE.height);
  ctx.stroke();
}

function Grip({ v }: { v: PrecisionView }) {
  const zoom = useDawStore((s) => s.zoomPxPerSec);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [edge, setEdge] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      if (canvas.current) drawLoupe(canvas.current, v, zoom);
      const box = v.element.getBoundingClientRect();
      setEdge({ x: box.left + box.width / 2, y: box.top });
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [v, zoom]);
  const finger = v.finger ?? edge;
  if (!finger || !edge) return null;
  const left = Math.min(
    Math.max(finger.x - LOUPE.width / 2, 8),
    window.innerWidth - LOUPE.width - 8,
  );
  // The loupe sits above the finger and grows upward from there.
  const base = Math.max(finger.y - LOUPE.lift, LOUPE.height + 8);
  return (
    <div className="precision-grip" aria-hidden="true">
      <svg className="precision-grip-leader">
        <line x1={left + LOUPE.width / 2} y1={base} x2={edge.x} y2={edge.y} />
        <circle cx={edge.x} cy={edge.y} r="5" />
      </svg>
      <div
        className="precision-grip-loupe"
        style={{ left, bottom: window.innerHeight - base, width: LOUPE.width }}
      >
        <Readout v={v} />
        <canvas
          ref={canvas}
          className="precision-grip-canvas"
          style={{ width: LOUPE.width, height: LOUPE.height }}
        />
      </div>
    </div>
  );
}

/** Renders the active precision drag's surface, if any. */
export function PrecisionLayer() {
  const v = useSyncExternalStore(subscribePrecision, precisionView);
  if (!v) return null;
  const surface =
    v.variant === "jog" ? (
      <JogPad v={v} />
    ) : v.variant === "lens" ? (
      <Lens v={v} />
    ) : (
      <Grip v={v} />
    );
  return createPortal(
    <div className="precision-layer" data-variant={v.variant}>
      {surface}
    </div>,
    document.body,
  );
}
