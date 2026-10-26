export type DropOverlayProps = {
  /** The outcome of the current target: "New tracks". */
  label: string;
};

/**
 * A full-window frame while files are dragged. Decoration only: it is hidden
 * from assistive technology and never takes pointer or focus. The page
 * announces the outcome in its own live region.
 */
export function DropOverlay({ label }: DropOverlayProps) {
  return (
    <div className="sys-drop" aria-hidden="true">
      <span className="sys-drop-label">{label}</span>
    </div>
  );
}
