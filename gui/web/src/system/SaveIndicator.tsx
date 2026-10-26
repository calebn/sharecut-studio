import { SystemIcon } from "./SystemIcon";

export type SaveIndicatorProps = {
  state: "saved" | "saving" | "offline" | "failed";
  /** Saved: show the check for the 2 s after a save. */
  justSaved?: boolean;
  /** Offline: edits waiting to send. */
  waiting?: number;
  /** Narrow chrome: glyph and Retry only. */
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
  if (state === "failed") {
    return (
      <span className="sys-save sys-save--failed" role="status">
        <SystemIcon
          name="octagon-alert"
          size={16}
          className="sys-tone-danger"
        />
        {compact ? null : <span className="sys-save-text">Save failed</span>}
        <button type="button" className="sys-text-btn" onClick={onRetry}>
          Retry<span className="sr-only"> saving</span>
        </button>
        {compact ? null : (
          <button type="button" className="sys-text-btn" onClick={onDownload}>
            Download a copy
          </button>
        )}
      </span>
    );
  }
  if (state === "offline") {
    const text = waiting ? `${waiting} waiting` : "Offline";
    return (
      <span className="sys-save sys-save--offline" role="status">
        <SystemIcon name="cloud-off" size={16} className="sys-tone-warning" />
        <span className={compact ? "sr-only" : "sys-save-text"}>{text}</span>
        {compact && waiting ? (
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
