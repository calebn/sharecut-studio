import {
  reachOf,
  reviewMeta,
  roleLabel,
  roleOf,
  type ShareChoices,
  type ShareEnd,
  type ShareOptions,
  shareCopyKey,
  shareRowsOf,
} from "../../../stages/deliver/shareLogic";
import { type LinkMoreItem, LinkRow } from "../../../system/LinkRow";
import { type HostShareRow, REVIEW_ROLES } from "../../../types/shares";
import { InlineConfirm } from "../../../ui";
import { BUSY_REASON } from "../../../ui/disabledReason";
import { copyReasonOf, needsMixFor, SET_AT_MAKING } from "./inviteLogic";

type EndProps = {
  options: ShareOptions;
  pending: ShareEnd | null;
  onAsk: (end: ShareEnd) => void;
  onKeep: () => void;
  onConfirm: () => void;
};

/** One link that is made: its role, address, who opened it, Copy and More. */
export function MadeLinkRow({
  row,
  options,
  pending,
  onAsk,
  onKeep,
  onConfirm,
  highlight = false,
  share = false,
  compact = false,
  pinnedReason,
  linkName,
}: EndProps & {
  row: HostShareRow;
  highlight?: boolean;
  share?: boolean;
  compact?: boolean;
  pinnedReason?: string;
  /** Names the link for assistive technology; the role by default. */
  linkName?: string;
}) {
  const { busy, copiedKey, blockedKey, tunnel, onCopy } = options;
  const role = roleLabel(row);
  const key = shareCopyKey("link", row.token);
  const busyReason = busy ? BUSY_REASON : undefined;
  const confirming = pending?.kind === "link" && pending.token === row.token;
  const more: LinkMoreItem[] = [
    row.mcp_url
      ? {
          id: "mcp",
          label:
            copiedKey === shareCopyKey("mcp", row.token)
              ? "Copied MCP URL"
              : "Copy MCP URL",
          disabledReason: busyReason,
          onSelect: () =>
            onCopy("mcp", row.token, "MCP URL", row.mcp_url ?? null),
        }
      : {
          id: "mcp",
          label: "Allow AI assistants",
          checked: false,
          disabledReason: SET_AT_MAKING,
          onSelect: () => undefined,
        },
    {
      id: "stop",
      label: "Stop sharing",
      disabledReason: busyReason,
      onSelect: () => onAsk({ kind: "link", token: row.token }),
    },
  ];
  return (
    <LinkRow
      access={roleOf(row)}
      link={row.url}
      linkName={linkName ?? `${role} link`}
      placeholder="This link has no address to copy yet."
      copyState={
        copiedKey === key ? "copied" : blockedKey === key ? "blocked" : "idle"
      }
      reach={row.url ? reachOf(tunnel, row.url) : undefined}
      note={reviewMeta(row)}
      pin={{
        pressed: row.follow_latest === false,
        disabledReason: pinnedReason ?? SET_AT_MAKING,
      }}
      more={more}
      highlight={highlight}
      share={share}
      compact={compact}
      disabledReason={
        busyReason ??
        (row.url ? undefined : "This link has no address to copy yet.")
      }
      onCopy={() => onCopy("link", row.token, "Link", row.url)}
      confirming={
        confirming ? (
          <InlineConfirm
            prompt={`Stop sharing this ${role} link? Anyone using it loses access.`}
            keepLabel="Keep link"
            actionLabel="Stop sharing"
            disabledReason={busyReason}
            onKeep={onKeep}
            onConfirm={onConfirm}
          />
        ) : undefined
      }
    />
  );
}

/** The review links that exist, then a ready row for the next one: Commenter, following the latest, made on first Copy. */
export function ReviewLinks({
  labelledBy,
  ...props
}: EndProps & { labelledBy: string }) {
  const { options } = props;
  const { rows, choices, onChoices, onCreate, onRefreshMix } = options;
  const { review } = shareRowsOf(rows);
  const noMix = needsMixFor(options, { listen: false, choices });
  const busyReason = options.busy ? BUSY_REASON : undefined;
  return (
    <ul className="inv-list" aria-labelledby={labelledBy}>
      {review.map((row) => (
        <li key={row.token} className="inv-item">
          <MadeLinkRow {...props} row={row} />
        </li>
      ))}
      <li className="inv-item">
        <LinkRow
          access={choices.role}
          link={null}
          linkName={`new ${roleLabelOf(choices.role)} link`}
          onRole={(role) => onChoices({ ...choices, role })}
          note={
            choices.freeze
              ? "Pinned to this version"
              : "Follows the latest version"
          }
          pin={{
            pressed: choices.freeze,
            disabledReason: busyReason,
            onChange: (freeze) => onChoices({ ...choices, freeze }),
          }}
          more={[
            {
              id: "mcp",
              label: "Allow AI assistants",
              checked: choices.withMcp,
              disabledReason: busyReason,
              onSelect: () =>
                onChoices({ ...choices, withMcp: !choices.withMcp }),
            },
          ]}
          noMix={noMix ? { onRefresh: onRefreshMix } : undefined}
          disabledReason={copyReasonOf(options)}
          onCopy={() => onCreate()}
        />
      </li>
    </ul>
  );
}

function roleLabelOf(role: ShareChoices["role"]): string {
  return REVIEW_ROLES.find((r) => r.id === role)?.label ?? "Review";
}
