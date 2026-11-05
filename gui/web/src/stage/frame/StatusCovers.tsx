import { Cover } from "../../system/Cover";
import type { NotServed } from "../../utils/notServed";

export const BAD_LINK_TITLE = "This link doesn't open anything";
export const BAD_LINK_HINT = "Ask the person who sent it for a new link.";

/** A bad or revoked review link: no button for a guest, who can only ask. */
export function BadLinkCover({
  title = BAD_LINK_TITLE,
  hint = BAD_LINK_HINT,
}: {
  title?: string;
  hint?: string;
}) {
  return (
    <Cover size="page" glyph="unlink" title={title}>
      {hint}
    </Cover>
  );
}

/** The host's computer is asleep (or the link did not load): one way forward. */
export function HostCover({
  asleep,
  message,
  onRetry,
}: {
  asleep: boolean;
  /** The sentence for a link that failed to load; unused while the host is asleep. */
  message?: string;
  onRetry: () => void;
}) {
  return (
    <Cover
      size="page"
      glyph={asleep ? "moon" : "triangle-alert"}
      title={
        asleep ? "The host's computer is asleep" : "This link did not load"
      }
      primary={{ label: asleep ? "Try now" : "Retry", onClick: onRetry }}
    >
      {asleep ? "This page tries again every 30 seconds." : message}
    </Cover>
  );
}

/** This server is serving another episode: open it, or go to all projects. */
export function NotServedCover({
  notServed,
  onNavigate,
}: {
  notServed: NotServed;
  onNavigate: (href: string) => void;
}) {
  return (
    <Cover
      size="page"
      glyph="folder-open"
      title="This episode isn't open on this computer"
      primary={{
        label: `Open ${notServed.name}`,
        onClick: () => onNavigate(notServed.openHref),
      }}
      secondary={{
        label: "All projects",
        onClick: () => onNavigate(notServed.homeHref),
      }}
    >
      {`This computer is open on ${notServed.name}.`}
    </Cover>
  );
}
