import type {
  InspectorBounds,
  InspectorRect,
} from "../../system/inspectorSheetMath";
import { type AnchorRect, unionRect } from "../../ui/anchoredPlacement";

export type InspectorPlacement = Readonly<{
  anchor: Readonly<InspectorRect>;
  bounds: Readonly<InspectorBounds>;
}>;

type GeometryFrame = Readonly<{
  root: HTMLElement | null;
  anchorRef: Readonly<{ current: HTMLElement | null }>;
  panel: HTMLElement | null;
  revision: readonly unknown[];
  visible: boolean;
}>;

type Connection = Readonly<{
  frame: GeometryFrame;
  measure: () => void;
  dispose: () => void;
}>;

const rounded = (rect: InspectorRect): InspectorRect => ({
  x: Math.round(rect.x),
  y: Math.round(rect.y),
  width: Math.round(rect.width),
  height: Math.round(rect.height),
});

const samePlacement = (a: InspectorPlacement | null, b: InspectorPlacement) =>
  a != null &&
  a.bounds.width === b.bounds.width &&
  a.bounds.height === b.bounds.height &&
  a.anchor.x === b.anchor.x &&
  a.anchor.y === b.anchor.y &&
  a.anchor.width === b.anchor.width &&
  a.anchor.height === b.anchor.height;

const sameFrame = (a: GeometryFrame, b: GeometryFrame) =>
  a.root === b.root &&
  a.anchorRef === b.anchorRef &&
  a.panel === b.panel &&
  a.revision === b.revision &&
  a.visible === b.visible;

export function createInspectorPlacement(
  onPlacement: (placement: InspectorPlacement) => void,
) {
  let attachment: object | null = null;
  let connection: Connection | null = null;
  let previous: InspectorPlacement | null = null;
  return {
    attach: () => {
      connection?.dispose();
      const current = {};
      attachment = current;
      return () => {
        if (attachment !== current) return;
        attachment = null;
        connection?.dispose();
      };
    },
    connect: (input: GeometryFrame) => {
      if (!attachment || (connection && sameFrame(connection.frame, input)))
        return;
      connection?.dispose();
      let stopped = false;
      let delivered = false;
      const measure = () => {
        if (stopped || connection !== current || !input.root) return;
        const frame = input.root.getBoundingClientRect();
        const rects = [
          input.anchorRef.current,
          input.root.querySelector(".sys-actions--floating"),
        ].flatMap((el) => (el ? [el.getBoundingClientRect()] : []));
        const target = rects.length
          ? rects.slice(1).reduce<AnchorRect>(unionRect, rects[0])
          : null;
        const next: InspectorPlacement = {
          bounds: {
            width: Math.round(frame.width),
            height: Math.round(frame.height),
          },
          anchor: rounded(
            target
              ? {
                  x: target.left - frame.left,
                  y: target.top - frame.top,
                  width: target.right - target.left,
                  height: target.bottom - target.top,
                }
              : { x: frame.width / 2, y: frame.height, width: 0, height: 0 },
          ),
        };
        const value =
          previous && samePlacement(previous, next) ? previous : next;
        if (delivered && previous === value) return;
        previous = value;
        delivered = true;
        onPlacement(value);
      };
      const onScroll = (event: Event) => {
        if (stopped || connection !== current) return;
        if (event.target instanceof Node && input.panel?.contains(event.target))
          return;
        measure();
      };
      const dispose = () => {
        if (stopped) return;
        stopped = true;
        window.removeEventListener("resize", measure);
        window.removeEventListener("scroll", onScroll, true);
        if (connection === current) connection = null;
      };
      const current: Connection = { frame: input, measure, dispose };
      connection = current;
      window.addEventListener("resize", measure);
      window.addEventListener("scroll", onScroll, true);
      measure();
    },
    measure: () => connection?.measure(),
  };
}
