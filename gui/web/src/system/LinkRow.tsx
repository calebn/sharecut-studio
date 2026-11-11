import type { ReactNode } from "react";
import { useState } from "react";
import { Avatar, Button } from "../ui";
import { Menu, MenuItem } from "../ui/Menu";
import type { LinkRole } from "./linkRoles";
import { middleTruncate } from "./linkText";
import { type LinkReach, ReachGlyph } from "./ReachGlyph";
import { RoleChip } from "./RoleChip";
import { SystemIcon } from "./SystemIcon";
import { capsOf, iconOf } from "./verbDisplay";

export type LinkCopyState = "idle" | "copied" | "blocked";

/** One choice in a Link row's More menu. */
export type LinkMoreItem = {
  id: string;
  label: string;
  onSelect: () => void;
  /** A setting the item turns on or off, such as Allow AI assistants. */
  checked?: boolean;
  disabledReason?: string;
};

export type LinkRowProps = {
  access: LinkRole;
  /** Null until the first Copy mints it. */
  link: string | null;
  openedBy?: readonly { name: string; colorIndex?: number }[];
  copyState?: LinkCopyState;
  /** Phone: labels Copy as Share. It does not open the system share sheet. */
  share?: boolean;
  /** No mix exists: the row offers Refresh mix instead of a link. */
  noMix?: { onRefresh: () => void };
  /** Highlights Copy as the follow-up to an export. */
  highlight?: boolean;
  /** One short note, such as "Pinned to Rough cut". */
  note?: ReactNode;
  compact?: boolean;
  /** Online sharing: a globe glyph with a popover. Shown only once there is a link. */
  reach?: LinkReach;
  /** Lets the person pick the role while the link is not made yet. */
  onRole?: (role: LinkRole) => void;
  /** The pin toggle: frozen on this version (on) or following the latest (off). Without `onChange` it only shows the state. */
  pin?: {
    pressed: boolean;
    onChange?: (next: boolean) => void;
    disabledReason?: string;
  };
  /** How many people opened it; defaults to the avatars given. */
  openedCount?: number;
  /** The More menu: QR code, Allow AI assistants, Replace link, Stop sharing. Without items there is no button. */
  more?: readonly LinkMoreItem[];
  /** Names the link for assistive technology when a page has several rows: "Copy Commenter link". */
  linkName?: string;
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
  reach,
  onRole,
  pin,
  openedCount,
  more = [],
  linkName,
  disabledReason,
  placeholder = "Made when you copy it",
  onCopy,
}: LinkRowProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  if (noMix) {
    return (
      <div className="sys-link" data-state="no-mix">
        <span className="sys-link-text">Make a mix to share</span>
        <Button onClick={noMix.onRefresh}>Refresh mix</Button>
      </div>
    );
  }
  const people = openedCount ?? openedBy.length;
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
        <RoleChip
          access={access}
          compact={compact}
          onChange={link ? undefined : onRole}
          disabledReason={link ? undefined : disabledReason}
        />
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
      <div className="sys-link-side">
        {link && reach ? <ReachGlyph reach={reach} /> : null}
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
        {people > 0 ? (
          <span
            className="sys-link-count"
            data-testid="link-opened-count"
            {...(openedBy.length > 0
              ? { "aria-hidden": true }
              : {
                  role: "img",
                  "aria-label": `Opened by ${people} ${people === 1 ? "person" : "people"}`,
                })}
          >
            {people}
          </span>
        ) : null}
        {pin ? (
          <button
            type="button"
            className="sys-icon-btn"
            aria-pressed={pin.pressed}
            aria-label="Pin to this version"
            title={pin.disabledReason ?? "Pin to this version"}
            disabled={pin.disabledReason !== undefined || !pin.onChange}
            onClick={() => pin.onChange?.(!pin.pressed)}
          >
            <SystemIcon name="pin" size={14} />
          </button>
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
        {more.length > 0 ? (
          <Menu
            open={moreOpen}
            onOpenChange={setMoreOpen}
            label={linkName ? `More for ${linkName}` : "More"}
            trigger={(props) => (
              <Button
                {...props}
                aria-label={linkName ? `More for ${linkName}` : "More"}
                title="More"
              >
                <SystemIcon name="ellipsis" size={16} />
              </Button>
            )}
          >
            {more.map((item) => (
              <MenuItem
                key={item.id}
                checked={item.checked}
                disabledReason={item.disabledReason}
                onSelect={() => {
                  setMoreOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </MenuItem>
            ))}
          </Menu>
        ) : null}
      </div>
    </div>
  );
}
