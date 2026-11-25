import type { HostCause } from "../state/hostReach";
import {
  STORAGE_LIGHT,
  type StorageCause,
  storageSentence,
} from "../state/storageHealth";
import { SystemIcon } from "./SystemIcon";

export type SaveIndicatorProps = {
  state:
    | "saved"
    | "saving"
    | "offline"
    | "waiting"
    | "unreachable"
    | "unkept"
    | "away"
    | "failed";
  cause?: HostCause;
  /** Unkept: why this device keeps no saved copy. */
  storageCause?: StorageCause;
  /** Saved: show the check for the 2 s after a save. */
  justSaved?: boolean;
  /** Offline, unreachable or away: edits waiting to send. */
  waiting?: number;
  savedAt?: number;
  /**
   * Narrow chrome: glyph, a count and Retry only. The App header gets the same
   * form from its container width, so it does not pass this.
   */
  compact?: boolean;
  onRetry?: () => void;
  onDownload?: () => void;
};

const SAVED_COPY_TEXT =
  "Showing a saved copy because the host can't be reached. It is read-only.";

/** The save state after the title (design system 2, Frame 3). Props only. */
export function SaveIndicator({
  state,
  justSaved,
  waiting,
  savedAt,
  cause = "host",
  storageCause = "blocked",
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
  if (state === "offline" || state === "waiting") {
    const text = waiting
      ? `${waiting} waiting${state === "waiting" ? " to send" : ""}`
      : "Offline";
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
  if (state === "away") {
    const label =
      cause === "device" ? "You're offline" : "Can't reach the host";
    const sentence = `${label}${waiting ? `, ${waiting} waiting to send` : ""}. This page keeps trying.`;
    return (
      <span
        className={`sys-save sys-save--away${size}`}
        role="status"
        title={sentence}
      >
        <SystemIcon name="cloud-off" size={16} className="sys-tone-warning" />
        <span className="sys-save-text">
          <span aria-hidden="true">
            {waiting ? `${label} · ${waiting} waiting to send` : label}
          </span>
          <span className="sr-only">{sentence}</span>
        </span>
        {waiting ? (
          <span aria-hidden="true" className="sys-save-count">
            {waiting}
          </span>
        ) : null}
      </span>
    );
  }
  if (state === "unkept") {
    // Not a live region and not an alert: the frame's one status region says it once, and nothing here is for the guest to press.
    const sentence = storageSentence(storageCause);
    return (
      <span className={`sys-save sys-save--unkept${size}`} title={sentence}>
        <SystemIcon name="cloud-off" size={16} className="sys-tone-warning" />
        <span className="sys-save-short" aria-hidden="true">
          Not kept
        </span>
        <span className="sys-save-text">
          {STORAGE_LIGHT}
          <span className="sr-only">. {sentence}</span>
        </span>
      </span>
    );
  }
  if (state === "unreachable") {
    const date = new Date(savedAt ?? NaN);
    const label =
      savedAt !== undefined && savedAt > 0 && Number.isFinite(date.getTime())
        ? `Saved copy from ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date)}`
        : "Saved copy";
    return (
      <span
        className={`sys-save sys-save--unreachable${size}`}
        role="status"
        title={`${label}. ${SAVED_COPY_TEXT}`}
      >
        <SystemIcon name="cloud" size={16} className="sys-tone-warning" />
        <span className="sys-save-short" aria-hidden="true">
          Saved copy
        </span>
        <span className="sys-save-text">
          {waiting ? `${label} · ${waiting} waiting to send` : label}
          <span className="sr-only">. {SAVED_COPY_TEXT}</span>
        </span>
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
