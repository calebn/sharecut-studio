import {
  type HostShareRow,
  REVIEW_ROLES,
  type ShareRole,
} from "../../types/shares";
import type { TunnelStatus } from "../../types/tunnel";

export type ShareCopyKind = "link" | "mcp";
export type ShareCopiedKey = `${ShareCopyKind}:${string}`;

export function shareCopyKey(
  kind: ShareCopyKind,
  token: string,
): ShareCopiedKey {
  return `${kind}:${token}`;
}

/** The link the host just created, offered again beside Create review link. */
export type ShareLastCreated = {
  token: string;
  url: string;
  kind: "review" | "guest";
};

export type ShareCreateRecovery =
  | { kind: "idle" }
  | { kind: "needs_refresh"; message: string; refreshError: string | null }
  | { kind: "refreshing" }
  | { kind: "retrying" };

export const SHARE_MCP_HELP =
  "Paste into an MCP client such as Claude or ChatGPT. The assistant gets this link's permissions.";

export const SHARE_FREEZE_HELP =
  "Guests keep hearing this version even after you publish a newer one. Off, the link follows the latest.";

/** Who can open the links: `network` when only this network can. */
export type ShareReach = "anywhere" | "network";

/** What the Deliver host gives the Share section. */
export type ShareOptions = {
  role: ShareRole;
  onRole: (role: ShareRole) => void;
  withMcp: boolean;
  onWithMcp: (on: boolean) => void;
  /** The new link plays the current version for good instead of following the latest. */
  freeze: boolean;
  onFreeze: (on: boolean) => void;
  /** Every host share row; the section shows usable rows only, split into review links and record rooms. */
  rows: readonly HostShareRow[];
  busy: boolean;
  createRecovery: ShareCreateRecovery;
  error: string | null;
  status: string | null;
  copiedKey: ShareCopiedKey | null;
  lastCreated: ShareLastCreated | null;
  /** Online sharing state; omitted when the `tunnel.status` feature is unavailable. */
  tunnel?: TunnelStatus | null;
  /** Omitted while the online sharing state is unknown. */
  reach?: ShareReach;
  onCreate: () => void;
  onRefreshMix: () => void;
  onCreateRecord: () => void;
  onCopy: (
    kind: ShareCopyKind,
    token: string,
    label: string,
    text: string | null,
  ) => void;
  onRevoke: (token: string) => void;
  onEndRoom: (sessionId: string) => void;
  onReplaceRecordInvite: (sourceToken: string) => void;
  onOpenRoomPanel: () => void;
  /** Move focus to Create review link once, then call `onFocused`. */
  focusRequested?: boolean;
  onFocused?: () => void;
};

/** Links reach anyone only once online sharing is set up and on; unknown stays unsaid. */
export function shareReachOf(
  tunnel: TunnelStatus | null | undefined,
): ShareReach | undefined {
  if (!tunnel) return undefined;
  return tunnel.state === "off" || tunnel.state === "not_set_up"
    ? "network"
    : "anywhere";
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function shareRoleLabel(row: HostShareRow): string {
  return (
    REVIEW_ROLES.find((r) => r.id === row.docs_role)?.label ??
    row.docs_role ??
    "Review"
  );
}

export function reviewMeta(row: HostShareRow): string {
  const parts: string[] = [];
  if (row.review_version_label) {
    parts.push(
      row.follow_latest
        ? `Follows latest: ${row.review_version_label}`
        : `Frozen on ${row.review_version_label}`,
    );
  }
  if (row.mcp_url) parts.push("AI assistants allowed");
  if (row.created_at) parts.push(`Created ${formatWhen(row.created_at)}`);
  if (row.last_used_at && row.last_used_at !== row.created_at) {
    parts.push(`Last opened ${formatWhen(row.last_used_at)}`);
  }
  if (row.expires_at) parts.push(`Expires ${formatWhen(row.expires_at)}`);
  return parts.join(" · ");
}

export type RecordRoomGroup = {
  sessionId: string;
  guests: HostShareRow[];
  producers: HostShareRow[];
};

export function groupRecordRooms(
  rows: readonly HostShareRow[],
): RecordRoomGroup[] {
  const map = new Map<string, RecordRoomGroup>();
  for (const row of rows) {
    const sid = row.session_id || row.token;
    const existing = map.get(sid) ?? {
      sessionId: sid,
      guests: [],
      producers: [],
    };
    if (row.record_role === "producer") existing.producers.push(row);
    else existing.guests.push(row);
    map.set(sid, existing);
  }
  return [...map.values()];
}

/** The one link or room whose end the host is confirming. */
export type PendingEnd =
  | { kind: "link"; token: string }
  | { kind: "room"; sessionId: string };

export function pendingKey(pending: PendingEnd): string {
  return pending.kind === "link"
    ? `link:${pending.token}`
    : `room:${pending.sessionId}`;
}
