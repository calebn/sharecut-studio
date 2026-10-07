/**
 * Where an armed drag is held (#1051 round 4b): a line through the lanes at
 * the soft boundary and a caption naming it, the drag's twin of the strip's
 * "stopped at" bump. Push on past it and both go.
 */
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ChooserBounds } from "./chooserLayout";
import type { DetentView } from "./hitRouting";

export function DetentMark({
  detent,
  bounds,
}: {
  detent: DetentView;
  /** The lanes' visible box: the line spans it. */
  bounds: ChooserBounds;
}) {
  if (detent.x < bounds.left || detent.x > bounds.right) return null;
  const style = {
    left: detent.x,
    top: bounds.top,
    height: Math.max(0, bounds.bottom - bounds.top),
  } as CSSProperties;
  return createPortal(
    <div className="detent-mark" style={style} aria-hidden="true">
      <span className="detent-mark-caption">At {detent.boundary.label}</span>
    </div>,
    document.body,
  );
}
