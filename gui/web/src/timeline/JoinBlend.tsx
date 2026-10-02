import type { JoinVisual } from "../edit/joinRender";
export function JoinBlend({ visual }: { visual: JoinVisual }) {
  if (visual.kind !== "blend") return null;
  return (
    <svg
      className="join-blend"
      aria-hidden="true"
      focusable="false"
      style={{ left: visual.leftPx, width: visual.widthPx }}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <path d="M0 0L100 100M100 0L0 100" />
    </svg>
  );
}
