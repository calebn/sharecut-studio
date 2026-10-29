import {
  type HostShareRow,
  REVIEW_ROLES,
  type ShareRole,
} from "../../types/shares";
import type { TunnelStatus } from "../../types/tunnel";
import { ApiError } from "../../utils/apiError";

export type ShareCopyKind = "link" | "mcp";
export type ShareCopiedKey = `${ShareCopyKind}:${string}`;

export function shareCopyKey(
  kind: ShareCopyKind,
  token: string,
): ShareCopiedKey {
  return `${kind}:${token}`;
}

/** What the person chose for the next review link. */
export type ShareChoices = {
  role: ShareRole;
  withMcp: boolean;
  /** The new link plays the current version for good instead of following the latest. */
  freeze: boolean;
};

export const SHARE_DEFAULTS: ShareChoices = {
  role: "commenter",
  withMcp: false,
  freeze: false,
};

export const MCP_HELP =
  "Paste into an MCP client such as Claude or ChatGPT. The assistant gets this link's permissions.";

export const FREEZE_HELP =
  "Guests keep hearing this version even after you publish a newer one. Off, the link follows the latest.";

export const PRESENCE_NOTE =
  "Everyone with the link sees your cursor, selection, playhead, and viewport while they are in the session.";

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function roleLabel(row: HostShareRow): string {
  return (
    REVIEW_ROLES.find((r) => r.id === row.docs_role)?.label ??
    row.docs_role ??
    "Review"
  );
}

/** The row's role as one of the three link roles, for its chip. */
export function roleOf(row: HostShareRow): ShareRole {
  return REVIEW_ROLES.find((r) => r.id === row.docs_role)?.id ?? "viewer";
}

/** Follows latest or Frozen, the MCP, and the dates, as one line. */
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

function groupRecordRooms(rows: readonly HostShareRow[]): RecordRoomGroup[] {
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

/** The usable rows, split into review links and record rooms. */
export function shareRowsOf(rows: readonly HostShareRow[]): {
  review: HostShareRow[];
  rooms: RecordRoomGroup[];
} {
  const live = rows.filter((row) => row.usable);
  return {
    review: live.filter((row) => row.kind !== "record"),
    rooms: groupRecordRooms(live.filter((row) => row.kind === "record")),
  };
}

const PRIVATE_HOST =
  /^(localhost|\[?::1\]?|0\.0\.0\.0|127\.[\d.]+|10\.[\d.]+|192\.168\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+|169\.254\.[\d.]+|[^.]+|.+\.local|.+\.lan|.+\.home\.arpa)$/i;

/**
 * Whether a row says "only people on this network": when online sharing is
 * off, or unset and the link is on this computer or its network. While it is
 * connecting, reconnecting or offline, the status line above says so and a row
 * adds no note.
 */
export function reachOf(
  tunnel: TunnelStatus | null | undefined,
  url: string | null,
): "anywhere" | "network" {
  if (tunnel && tunnel.state !== "not_set_up") {
    return tunnel.state === "off" ? "network" : "anywhere";
  }
  if (!url) return "anywhere";
  try {
    return PRIVATE_HOST.test(new URL(url).hostname) ? "network" : "anywhere";
  } catch {
    return "anywhere";
  }
}

/** Where a failed create leaves the person. */
export type ShareCreateRecovery =
  | { kind: "idle" }
  | { kind: "needs_refresh"; message: string; refreshError: string | null }
  | { kind: "refreshing" }
  | { kind: "retrying" };

/** API error codes whose fix is Refresh mix, with the copy that pairs each with it. */
const REFRESH_MIX_MESSAGES: ReadonlyMap<string, string> = new Map([
  [
    "no_mix",
    "This project has no mix yet. Refresh the mix to create the link.",
  ],
  [
    "stale_mix",
    "The mix preview is out of date. Refresh it before creating a review link.",
  ],
]);

const STALE_MASTER_MESSAGE =
  "The mastered mix is out of date. Export a new master before creating a review link.";

/** What a failed create means: Refresh mix will fix it, only an export will, or it is just an error. */
export function createRecoveryOf(
  err: unknown,
):
  | { kind: "refresh"; message: string }
  | { kind: "stale_master"; message: string }
  | { kind: "error" } {
  if (err instanceof ApiError && err.code) {
    const refresh = REFRESH_MIX_MESSAGES.get(err.code);
    if (refresh) return { kind: "refresh", message: refresh };
    if (err.code === "stale_master") {
      return { kind: "stale_master", message: STALE_MASTER_MESSAGE };
    }
  }
  return { kind: "error" };
}

/** The warning to show when the share origin has no CORS rule on the bucket, else null. */
export function corsWarning(share: HostShareRow): string | null {
  const warning = share.warnings?.find((w) => w.code === "object_store_cors");
  if (!warning) return null;
  return `Link created, but its bucket has no CORS rule for ${warning.origin ?? "the share origin"}, so guests stream through your connection until you add one. The rule to paste is in docs/host-online-relay.md.`;
}

export const ROOM_LINK_COPY = {
  guest: {
    title: "Guest link",
    closed: "Guest invite closed to new guests",
    copyLabel: "Guest link",
    copy: "Copy guest link",
    copied: "Copied guest link",
    replace: "Replace guest invite",
  },
  producer: {
    title: "Producer link",
    closed: "Producer invite closed to new producers",
    copyLabel: "Producer link",
    copy: "Copy producer link",
    copied: "Copied producer link",
    replace: "Replace producer invite",
  },
} as const;

/** The one link or room whose end the person is confirming. */
export type ShareEnd =
  | { kind: "link"; token: string }
  | { kind: "room"; sessionId: string };

export function shareEndKey(end: ShareEnd): string {
  return end.kind === "link" ? `link:${end.token}` : `room:${end.sessionId}`;
}

/** What the Share section shows and does, from the host's flow. */
export type ShareOptions = {
  /** Every host share row; the section shows the usable ones. */
  rows: readonly HostShareRow[];
  /** False until the first list answers. */
  loaded: boolean;
  choices: ShareChoices;
  onChoices: (next: ShareChoices) => void;
  /** One action runs at a time; the buttons wait. */
  busy: boolean;
  recovery: ShareCreateRecovery;
  error: string | null;
  status: string | null;
  /** The copy button that reads Copied for 2 s. */
  copiedKey: ShareCopiedKey | null;
  /** The copy the browser refused: its link is selected for Mod+C. */
  blockedKey: ShareCopiedKey | null;
  /** Online sharing state; null or undefined when the `tunnel.status` feature is unavailable. */
  tunnel?: TunnelStatus | null;
  /** Why Share is unavailable (the command's reason); undefined when it is available. */
  blockedReason?: string;
  /** Mints the link from the click that asks for it. */
  onCreate: () => void;
  onRefreshMix: () => void;
  onCopy: (
    kind: ShareCopyKind,
    token: string,
    label: string,
    text: string | null,
  ) => void;
  onStop: (token: string) => void;
  onCreateRecord: () => void;
  onReplaceInvite: (sourceToken: string) => void;
  onEndRoom: (sessionId: string) => void;
  onOpenRecord: () => void;
  /** Something asked to bring Share into view: focus Create review link (or the first enabled button), then call `onFocused`. */
  focusRequested?: boolean;
  onFocused?: () => void;
};
