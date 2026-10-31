import {
  type CSSProperties,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { LONG_PRESS_MS, TOUCH_SLOP_PX } from "../../hooks/gestureConstants";
import { Measured } from "../../system/laneStoryHost";
import { Button } from "../../ui";
import { TARGET_ID_ATTR } from "./chooserKinds";
import { type ChooserTarget, TargetChooser } from "./TargetChooser";

const CHOOSER_BOX_HEIGHT = 320;

const LANE = { top: 216, bottom: 296 };

type ChooserDemoProps = {
  targets: readonly ChooserTarget[];
  /** The press point; a negative x counts from the box's right edge. */
  at: { x: number; y: number };
  /** The chip the finger starts over, for a story that shows the caption. */
  over?: string | null;
  /** False starts closed, so the first long-press is what opens the fan. */
  initialOpen?: boolean;
};

const box: CSSProperties = {
  position: "relative",
  boxSizing: "border-box",
  inlineSize: "100%",
  blockSize: CHOOSER_BOX_HEIGHT,
  overflow: "hidden",
  background: "var(--color-bg-canvas)",
  border: "1px solid var(--color-border)",
};

const lane: CSSProperties = {
  position: "absolute",
  inset: `${LANE.top}px 0 auto 0`,
  blockSize: LANE.bottom - LANE.top,
  background: "var(--color-timeline-lane)",
};

const surface: CSSProperties = {
  position: "absolute",
  inset: 0,
  touchAction: "none",
  userSelect: "none",
  WebkitTouchCallout: "none",
};

type Press = { x: number; y: number; timer: number | null };

/**
 * The positioned box the leaf is mounted in, with the press and the open state
 * a host would keep. It is a story fixture, not the router: its grammar is a
 * stub (hold, slide, lift), so the e2e proves the leaf's geometry and its
 * `over`, `onPick` and `onCancel` contract, not the app's hit routing. A press
 * on the surface held for `LONG_PRESS_MS` opens the fan at that point; the
 * finger sliding over a chip reports it as `over`; a lift over a chip picks it
 * and a lift elsewhere, or a cancelled touch, cancels. The fan starts open at
 * `at` so a story can show it without a hold, unless `initialOpen` is false.
 */
export function ChooserDemo({
  targets,
  at,
  over: startOver,
  initialOpen = true,
}: ChooserDemoProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const press = useRef<Press | null>(null);
  const [open, setOpen] = useState(initialOpen);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [over, setOver] = useState<string | null>(startOver ?? null);
  const [result, setResult] = useState({ text: "", picks: 0, cancels: 0 });

  useEffect(
    () => () => {
      if (press.current?.timer != null) clearTimeout(press.current.timer);
    },
    [],
  );

  const pointIn = (event: PointerEvent) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    };
  };
  const stopTimer = () => {
    if (press.current?.timer != null) clearTimeout(press.current.timer);
    if (press.current) press.current.timer = null;
  };
  const cancel = () =>
    setResult((r) => ({
      text: "Cancelled",
      picks: r.picks,
      cancels: r.cancels + 1,
    }));
  const pick = (id: string) => {
    const label = targets.find((target) => target.id === id)?.label ?? id;
    setResult((r) => ({
      text: `Picked: ${label}`,
      picks: r.picks + 1,
      cancels: r.cancels,
    }));
  };
  const close = () => {
    setOpen(false);
    setOver(null);
  };

  return (
    <div style={{ padding: "var(--space-4)" }}>
      <Measured>
        {(measured) => {
          // The box has a 1 px border on each side.
          const width = measured - 2;
          const start = {
            x: at.x < 0 ? width + at.x : at.x,
            y: at.y,
          };
          return (
            <div style={box}>
              <div style={lane} />
              <div
                ref={surfaceRef}
                style={surface}
                data-chooser-surface=""
                onContextMenu={(event) => event.preventDefault()}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  stopTimer();
                  close();
                  const from = pointIn(event);
                  const held: Press = { ...from, timer: null };
                  held.timer = window.setTimeout(() => {
                    held.timer = null;
                    setAnchor(from);
                    setOpen(true);
                  }, LONG_PRESS_MS);
                  press.current = held;
                }}
                onPointerMove={(event) => {
                  const now = pointIn(event);
                  const held = press.current;
                  if (
                    held?.timer != null &&
                    Math.hypot(now.x - held.x, now.y - held.y) > TOUCH_SLOP_PX
                  ) {
                    stopTimer();
                  }
                  if (!open) return;
                  const id = document
                    .elementFromPoint(event.clientX, event.clientY)
                    ?.closest(`[${TARGET_ID_ATTR}]`)
                    ?.getAttribute(TARGET_ID_ATTR);
                  setOver(id ?? null);
                }}
                onPointerUp={() => {
                  stopTimer();
                  press.current = null;
                  if (!open) return;
                  if (over) pick(over);
                  else cancel();
                  close();
                }}
                onPointerCancel={() => {
                  stopTimer();
                  press.current = null;
                  if (!open) return;
                  cancel();
                  close();
                }}
              />
              {open ? (
                <TargetChooser
                  targets={targets}
                  anchor={anchor ?? start}
                  bounds={{
                    left: 0,
                    top: 0,
                    right: width,
                    bottom: CHOOSER_BOX_HEIGHT,
                  }}
                  over={over}
                  onPick={(id) => {
                    pick(id);
                    close();
                  }}
                  onCancel={() => {
                    cancel();
                    close();
                  }}
                />
              ) : null}
            </div>
          );
        }}
      </Measured>
      <p
        aria-live="polite"
        data-picks={result.picks}
        data-cancels={result.cancels}
      >
        {result.text}
      </p>
      {open ? null : (
        <Button
          onClick={() => {
            setAnchor(null);
            setOpen(true);
          }}
        >
          Open the chooser again
        </Button>
      )}
    </div>
  );
}
