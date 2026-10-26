import { useId } from "react";
import { KeyCaps } from "./KeyCaps";
import { SystemIcon } from "./SystemIcon";
import { verbOf } from "./verbDisplay";

export type StartTileProps = {
  kind: "import" | "record";
  /** Tile height in px; `phone-bar` is the 72 px half of the thumb-zone bar. */
  size: 220 | 160 | 80 | "phone-bar";
  state?: "rest" | "drag-hover" | "disabled";
  /** Shown in place of the line when `state` is `disabled`. */
  disabledReason?: string;
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
  onActivate,
}: StartTileProps) {
  const titleId = useId();
  const noteId = useId();
  const disabled = state === "disabled";
  const { title, line } = COPY[kind];
  const note = disabled && disabledReason ? disabledReason : line;
  const compact = size === 80;
  return (
    <button
      type="button"
      className={`sys-start sys-start--${kind} sys-start--${size}`}
      data-state={state}
      aria-disabled={disabled || undefined}
      aria-labelledby={titleId}
      aria-describedby={compact ? undefined : noteId}
      onClick={disabled ? undefined : onActivate}
    >
      <span className="sys-start-icon">
        <SystemIcon
          name={kind === "import" ? "file-plus" : "record"}
          size={32}
        />
      </span>
      <span className="sys-start-text">
        <span id={titleId} className="sys-start-title">
          {title}
        </span>
        {compact ? null : (
          <span id={noteId} className="sys-start-line">
            {note}
          </span>
        )}
      </span>
      {size === "phone-bar" || compact ? null : (
        <KeyCaps chords={verbOf(kind).keys.slice(0, 1)} />
      )}
    </button>
  );
}
