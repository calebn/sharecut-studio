import type { ReactNode } from "react";
import { Avatar, Button } from "../ui";
import type { LinkRole } from "./linkRoles";
import { middleTruncate } from "./linkText";
import { RoleChip, RolePicker } from "./RoleChip";
import { SystemIcon } from "./SystemIcon";
import { VerbButton } from "./VerbButton";
import { capsOf, iconOf } from "./verbDisplay";

export type LinkCopyState = "idle" | "copied" | "blocked";

export type LinkRowProps = {
  access: LinkRole;
  /** Set when the role can change; otherwise the role is a chip. */
  onAccess?: (access: LinkRole) => void;
  /** Null until the first Copy mints it. */
  link: string | null;
  /** Who opened it. */
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
  onCopy: () => void;
  onMore?: () => void;
};

/** Cut the middle out of a long link so both ends stay readable. */

/** A link and what it allows: role, link, who opened it, Copy and More. */
export function LinkRow({
  access,
  onAccess,
  link,
  openedBy = [],
  copyState = "idle",
  share = false,
  noMix,
  highlight = false,
  note,
  compact = false,
  onCopy,
  onMore,
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
      : copyState === "blocked"
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
        {onAccess ? (
          <RolePicker access={access} onChange={onAccess} compact={compact} />
        ) : (
          <RoleChip access={access} compact={compact} />
        )}
        <span
          className="sys-link-text sys-mono"
          data-selected={copyState === "blocked" || undefined}
          title={link ?? undefined}
        >
          {link ? middleTruncate(link) : "Made when you copy it"}
        </span>
      </div>
      {note ? <span className="sys-link-note">{note}</span> : null}
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
        <Button variant="default" onClick={onCopy} aria-live="polite">
          <SystemIcon name={iconOf("copyLink")} size={14} />
          {label}
        </Button>
        {onMore ? <VerbButton verb="more" onClick={onMore} /> : null}
      </div>
    </div>
  );
}
