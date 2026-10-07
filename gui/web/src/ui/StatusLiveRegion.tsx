type Props = {
  /** The last announcement (`statusAnnouncement`). */
  message: string;
  /** Its sequence number (`statusAnnouncementSeq`); a new one re-speaks the same text. */
  seq: number;
};

/**
 * The shell's single polite live region (desktop status bar, phone shell).
 * Each announcement renders as a fresh text node keyed by its sequence number,
 * so a message repeated word for word ("Reordered track" twice) still changes
 * the region and is spoken again. The app toast shows the same message
 * without a live role of its own.
 */
export function StatusLiveRegion({ message, seq }: Props) {
  return (
    <span
      className="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span key={seq}>{message}</span>
    </span>
  );
}
