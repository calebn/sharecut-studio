import { KeyCaps } from "./KeyCaps";
import { SystemIcon } from "./SystemIcon";
import { verbOf } from "./verbDisplay";

type StartTileProps = {
  kind: "import" | "record";
  /** Tile height in px; `phone-bar` is the 72 px half of the thumb-zone bar. */
  size: 240 | 220 | 160 | 80 | "phone-bar";
  state?: "rest" | "drag-hover" | "disabled";
  /** Shown in place of the line when `state` is `disabled`. */
  disabledReason?: string;
  /** `primary` is the filled accent tile: the one action on an empty Home. */
  variant?: "default" | "primary";
  /** Files being dragged over the tile; worded in the drag-hover line. */
  dragCount?: number;
  /** Show the shortcut key caps. Off where the keys are not bound (Home). */
  showKeys?: boolean;
  onActivate: () => void;
};

const COPY = {
  import: { title: "Import audio", line: "Drop files or choose" },
  record: { title: "Record", line: "Invite guests and record" },
} as const;

/** A large tap-and-drop target that starts an episode: Import audio or Record. */
export function StartTile({
  kind,
  size,
  state = "rest",
  disabledReason,
  variant = "default",
  dragCount,
  showKeys = true,
  onActivate,
}: StartTileProps) {
  const disabled = state === "disabled";
  const { title, line } = COPY[kind];
  const dragging = state === "drag-hover";
  const dropLine =
    dragCount === undefined
      ? "Drop to add files"
      : `Drop to add ${dragCount} ${dragCount === 1 ? "file" : "files"}`;
  const reason = disabled && disabledReason ? disabledReason : null;
  const note = reason ?? (dragging ? dropLine : line);
  // The 80 px tile drops its line, but still says why it is disabled and
  // what a drop does.
  const compact = size === 80;
  const showNote = !compact || reason !== null || dragging;
  return (
    <button
      type="button"
      className={`sys-start sys-start--${kind} sys-start--${size}${variant === "primary" ? " sys-start--primary" : ""}`}
      data-state={state}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onActivate}
    >
      <span className="sys-start-icon">
        <SystemIcon
          name={kind === "import" ? "file-plus" : "record"}
          size={32}
        />
      </span>
      <span className="sys-start-text">
        <span className="sys-start-title">{title}</span>
        {showNote ? <span className="sys-start-line">{note}</span> : null}
      </span>
      {size === "phone-bar" || compact || !showKeys ? null : (
        <KeyCaps chords={verbOf(kind).keys.slice(0, 1)} />
      )}
    </button>
  );
}
