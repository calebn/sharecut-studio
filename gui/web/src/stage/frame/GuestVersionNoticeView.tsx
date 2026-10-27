import { Button } from "../../ui/Button";

export interface GuestVersionNoticeViewProps {
  /** Label of the version this link plays; null while the host left it unnamed. */
  label: string | null;
  /** The link plays whatever version is current, so it can change under the guest. */
  followsLatest: boolean;
  /** A newer version a frozen link does not play (its label may be unnamed); null when there is none. */
  newer: { label: string | null } | null;
  /** The version a following link plays changed since this page loaded. */
  changed: boolean;
  /** Who shared the link, to name who to ask for a newer one. */
  author?: string | null;
  onReload: () => void;
}

function versionName(label: string | null): string {
  return label ? `"${label}"` : "an unnamed version";
}

/** Props-only rendering of which review version a guest hears, for live state and the catalog. */
export function GuestVersionNoticeView({
  label,
  followsLatest,
  newer,
  changed,
  author,
  onReload,
}: GuestVersionNoticeViewProps) {
  const heard = `Hearing ${versionName(label)}.`;
  const attention = changed || (!followsLatest && newer !== null);
  let text: string;
  if (followsLatest) {
    text = changed
      ? `The shared version changed to ${versionName(label)}. Reload to hear it.`
      : `${heard} This link follows the latest version, so it can change.`;
  } else if (newer !== null) {
    text = `${heard} Newer version available: ${versionName(newer.label)}. Ask ${author || "the person who shared this"} for a new link.`;
  } else {
    text = `${heard} This link stays on this version.`;
  }
  return (
    <div
      className={
        attention ? "guest-version guest-version--attention" : "guest-version"
      }
      role="status"
    >
      <span className="guest-version-text">{text}</span>
      {changed && (
        <Button variant="link" onClick={onReload}>
          Reload
        </Button>
      )}
    </div>
  );
}
