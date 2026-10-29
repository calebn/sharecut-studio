import type { ReactNode } from "react";
import { Avatar, Button } from "../ui";
import type { LinkRole } from "./linkRoles";
import { middleTruncate } from "./linkText";
import { RoleChip } from "./RoleChip";
import { SystemIcon } from "./SystemIcon";
import { capsOf, iconOf } from "./verbDisplay";

export type LinkCopyState = "idle" | "copied" | "blocked";

export type LinkRowProps = {
  access: LinkRole;
  /** Null until the first Copy mints it. */
  link: string | null;
  openedBy?: readonly { name: string; colorIndex?: number }[];
  copyState?: LinkCopyState;
  /** Phone: Copy hands the link to the system share sheet. */
  share?: boolean;
  /** No mix exists: the row offers Refresh mix instead of a link. */
  noMix?: { onRefresh: () => void };
  /** Highlights Copy as the follow-up to an export. */
  highlight?: boolean;
  /** One short note, such as "Pinned to Rough cut". */
  note?: ReactNode;
  compact?: boolean;
  reach?: "anywhere" | "network";
  /** Names the link for assistive technology when a page has several rows: "Copy Commenter link". */
  linkName?: string;
  /** Copy waits, and says why. */
  disabledReason?: string;
  /** Shown while there is no link; the default says the first Copy makes it. */
  placeholder?: string;
  onCopy: () => void;
};

export function LinkRow({
  access,
  link,
  openedBy = [],
  copyState = "idle",
  share = false,
  noMix,
  highlight = false,
  note,
  compact = false,
  reach = "anywhere",
  linkName,
  disabledReason,
  placeholder = "Made when you copy it",
  onCopy,
}: LinkRowProps) {
  if (noMix) {
    return (
      <div className="sys-link" data-state="no-mix">
        <span className="sys-link-text">Make a mix to share</span>
        <Button onClick={noMix.onRefresh}>Refresh mix</Button>
      </div>
    );
  }
  const label =
    copyState === "copied"
      ? "Copied"
      : copyState === "blocked" && !share
        ? `Press ${capsOf({ key: "C", mod: true }).join(" ")}`
        : share
          ? "Share"
          : "Copy";
  return (
    <div
      className="sys-link"
      data-copy={copyState}
      data-highlight={highlight ? "true" : undefined}
    >
      <div className="sys-link-main">
        <RoleChip access={access} compact={compact} />
        <span
          className="sys-link-text sys-mono"
          data-selected={copyState === "blocked" || undefined}
          title={link ?? undefined}
        >
          {link
            ? copyState === "blocked"
              ? link
              : middleTruncate(link)
            : placeholder}
        </span>
      </div>
      {note ? <span className="sys-link-note">{note}</span> : null}
      {reach === "network" ? (
        <span className="sys-link-reach">
          <SystemIcon name={iconOf("copyLink")} size={14} />
          Only people on this network can listen. Turn on online sharing to
          reach anyone.
        </span>
      ) : null}
      <div className="sys-link-side">
        {openedBy.length > 0 ? (
          <span
            className="sys-link-opened"
            role="img"
            aria-label={`Opened by ${openedBy.map((p) => p.name).join(", ")}`}
          >
            {openedBy.slice(0, 3).map((p) => (
              <Avatar
                key={p.name}
                name={p.name}
                colorIndex={p.colorIndex}
                size="sm"
              />
            ))}
          </span>
        ) : null}
        <Button
          variant="default"
          disabledReason={disabledReason}
          aria-label={linkName ? `${label} ${linkName}` : undefined}
          onClick={onCopy}
          aria-live="polite"
        >
          <SystemIcon name={iconOf("copyLink")} size={14} />
          {label}
        </Button>
      </div>
    </div>
  );
}
