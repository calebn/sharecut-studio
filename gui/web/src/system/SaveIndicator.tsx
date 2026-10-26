import { SystemIcon } from "./SystemIcon";

export type SaveIndicatorProps = {
  state: "saved" | "saving" | "offline" | "failed";
  /** Saved: show the check for the 2 s after a save. */
  justSaved?: boolean;
  /** Offline: edits waiting to send. */
  waiting?: number;
  /**
   * Narrow chrome: glyph, a count and Retry only. The App header gets the same
   * form from its container width, so it does not pass this.
   */
  compact?: boolean;
  onRetry?: () => void;
  onDownload?: () => void;
};

/** The save state after the title (design system 2, Frame 3). Props only. */
export function SaveIndicator({
  state,
  justSaved,
  waiting,
  compact,
  onRetry,
  onDownload,
}: SaveIndicatorProps) {
  const size = compact ? " sys-save--compact" : "";
  if (state === "failed") {
    // A group, not a live region: Retry and Download are controls. Only the
    // failure text is announced.
    return (
      <span
        className={`sys-save sys-save--failed${size}`}
        role="group"
        aria-label="Save status"
      >
        <span className="sys-save-alert" role="alert">
          <SystemIcon
            name="octagon-alert"
            size={16}
            className="sys-tone-danger"
          />
          <span className="sys-save-text">Save failed</span>
        </span>
        <button type="button" className="sys-text-btn" onClick={onRetry}>
          Retry<span className="sr-only"> saving</span>
        </button>
        {onDownload ? (
          <button
            type="button"
            className="sys-text-btn sys-save-download"
            onClick={onDownload}
          >
            Download a copy
          </button>
        ) : null}
      </span>
    );
  }
  if (state === "offline") {
    const text = waiting ? `${waiting} waiting` : "Offline";
    return (
      <span className={`sys-save sys-save--offline${size}`} role="status">
        <SystemIcon name="cloud-off" size={16} className="sys-tone-warning" />
        <span className="sys-save-text">{text}</span>
        {waiting ? (
          <span aria-hidden="true" className="sys-save-count">
            {waiting}
          </span>
        ) : null}
      </span>
    );
  }
  if (state === "saving") {
    return (
      <span className="sys-save" role="status">
        <SystemIcon name="progress-ring" size={12} progress={0.3} />
        <span className="sr-only">Saving</span>
      </span>
    );
  }
  return (
    <span className="sys-save" role="status">
      {justSaved ? <SystemIcon name="check" size={12} /> : null}
      <span className="sr-only">Saved</span>
    </span>
  );
}
