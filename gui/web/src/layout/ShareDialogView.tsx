import { type RefCallback, useId, useRef, useState } from "react";
import {
  type HostShareRow,
  REVIEW_ROLES,
  type ShareRole,
} from "../types/shares";
import type { TunnelStatus } from "../types/tunnel";
import { Button, Dialog, EmptyState, InlineConfirm, InlineError } from "../ui";
import {
  type ShareCopiedKey,
  type ShareCopyKind,
  shareCopyKey,
} from "./shareCopyKey";
import { TunnelStatusLine } from "./TunnelStatusLine";

const MCP_HELP =
  "Paste into an MCP client such as Claude or ChatGPT. The assistant gets this link's permissions.";

function formatWhen(iso: string | null | undefined): string {
  if (!iso) {
    return "";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function roleLabel(row: HostShareRow): string {
  return (
    REVIEW_ROLES.find((r) => r.id === row.docs_role)?.label ??
    row.docs_role ??
    "Review"
  );
}

function reviewMeta(row: HostShareRow): string {
  const parts: string[] = [];
  if (row.review_version_label) {
    parts.push(row.review_version_label);
  }
  if (row.mcp_url) {
    parts.push("AI assistants allowed");
  }
  if (row.created_at) {
    parts.push(`Created ${formatWhen(row.created_at)}`);
  }
  if (row.last_used_at && row.last_used_at !== row.created_at) {
    parts.push(`Last opened ${formatWhen(row.last_used_at)}`);
  }
  if (row.expires_at) {
    parts.push(`Expires ${formatWhen(row.expires_at)}`);
  }
  return parts.join(" · ");
}

type RecordRoomGroup = {
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
    if (row.record_role === "producer") {
      existing.producers.push(row);
    } else {
      existing.guests.push(row);
    }
    map.set(sid, existing);
  }
  return [...map.values()];
}

/** The one link or room whose end the host is confirming. */
type PendingEnd =
  | { kind: "link"; token: string }
  | { kind: "room"; sessionId: string };

function pendingKey(pending: PendingEnd): string {
  return pending.kind === "link"
    ? `link:${pending.token}`
    : `room:${pending.sessionId}`;
}

/** The link the host just created, offered again in the footer. */
export type ShareLastCreated = {
  token: string;
  url: string;
  kind: "review" | "guest";
};

export type ShareDialogViewProps = {
  open: boolean;
  onClose: () => void;
  role: ShareRole;
  onRoleChange: (role: ShareRole) => void;
  withMcp: boolean;
  onWithMcpChange: (on: boolean) => void;
  /** Every host share row; the view shows usable rows only, split into review links and record rooms. */
  rows: readonly HostShareRow[];
  busy: boolean;
  createRecovery: ShareCreateRecovery;
  error: string | null;
  status: string | null;
  copiedKey: ShareCopiedKey | null;
  lastCreated: ShareLastCreated | null;
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
  /** Online sharing state; omitted when the `tunnel.status` feature is unavailable. */
  tunnel?: TunnelStatus | null;
};

export type ShareCreateRecovery =
  | { kind: "idle" }
  | { kind: "needs_refresh"; message: string; refreshError: string | null }
  | { kind: "refreshing" }
  | { kind: "retrying" };

/**
 * Production Share dialog paint, including the in-place Stop sharing and End
 * room confirmations. Listing, minting and revoking links, the clipboard
 * write, the copied-flash timer and the record-panel handoff stay with the
 * `ShareDialog` adapter.
 */
export function ShareDialogView(props: ShareDialogViewProps) {
  const { open, onClose } = props;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Share"
      panelClassName="share-dialog-panel"
      phoneSheet
      footer={<ShareDialogFooter {...props} />}
    >
      <ShareDialogBody {...props} />
    </Dialog>
  );
}

function ShareDialogFooter({
  rows,
  busy,
  createRecovery,
  error,
  status,
  copiedKey,
  lastCreated,
  onCreate,
  onRefreshMix,
  onCopy,
}: ShareDialogViewProps) {
  const reCopy =
    lastCreated &&
    rows.some((row) => row.usable && row.token === lastCreated.token)
      ? lastCreated
      : null;
  const reCopyLabel = reCopy?.kind === "guest" ? "guest link" : "link";
  return (
    <div className="share-dialog-footer">
      {createRecovery.kind === "needs_refresh" ? (
        <div className="share-dialog-recovery">
          <p role="alert">{createRecovery.message}</p>
          <Button type="button" disabled={busy} onClick={onRefreshMix}>
            Refresh mix
          </Button>
          {createRecovery.refreshError ? (
            <p>Refresh failed: {createRecovery.refreshError}</p>
          ) : null}
        </div>
      ) : null}
      <div className="share-dialog-footer-bar">
        <div className="share-dialog-feedback" aria-live="polite">
          {error ? <InlineError message={error} /> : null}
          {!error && createRecovery.kind === "refreshing" ? (
            <p className="share-dialog-status">Refreshing mix preview…</p>
          ) : null}
          {!error && createRecovery.kind === "retrying" ? (
            <p className="share-dialog-status">
              Mix refreshed. Creating review link…
            </p>
          ) : null}
          {status && !error && createRecovery.kind === "idle" ? (
            <p className="share-dialog-status">{status}</p>
          ) : null}
        </div>
        <div className="share-dialog-footer-actions">
          {reCopy ? (
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                onCopy(
                  "link",
                  reCopy.token,
                  reCopy.kind === "guest" ? "Guest link" : "Link",
                  reCopy.url,
                )
              }
            >
              {copiedKey === shareCopyKey("link", reCopy.token)
                ? `Copied ${reCopyLabel}`
                : `Copy ${reCopyLabel}`}
            </Button>
          ) : null}
          <Button
            variant="primary"
            type="button"
            disabled={busy}
            onClick={onCreate}
          >
            Create review link
          </Button>
        </div>
      </div>
    </div>
  );
}

function ShareDialogBody(props: ShareDialogViewProps) {
  const {
    role,
    onRoleChange,
    withMcp,
    onWithMcpChange,
    rows,
    busy,
    onCreateRecord,
    onRevoke,
    onEndRoom,
    tunnel,
  } = props;
  const roleName = useId();
  const mcpId = useId();
  const mcpHelpId = useId();
  const reviewLinksHeadingId = useId();
  const recordRoomsHeadingId = useId();
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const roomsHeadingRef = useRef<HTMLHeadingElement>(null);
  const [pending, setPending] = useState<PendingEnd | null>(null);
  const refocusKey = useRef<string | null>(null);

  const live = rows.filter((row) => row.usable);
  const reviewLive = live.filter((row) => row.kind !== "record");
  const recordRooms = groupRecordRooms(
    live.filter((row) => row.kind === "record"),
  );

  const keep = () => {
    refocusKey.current = pending ? pendingKey(pending) : null;
    setPending(null);
  };
  const endTrigger =
    (target: PendingEnd): RefCallback<HTMLButtonElement> =>
    (el) => {
      if (el && refocusKey.current === pendingKey(target)) {
        refocusKey.current = null;
        el.focus();
      }
    };
  const confirmEnd = () => {
    if (!pending) {
      return;
    }
    setPending(null);
    if (pending.kind === "link") {
      onRevoke(pending.token);
      reviewHeadingRef.current?.focus();
    } else {
      onEndRoom(pending.sessionId);
      roomsHeadingRef.current?.focus();
    }
  };

  return (
    <div className="share-dialog-body">
      {tunnel ? <TunnelStatusLine status={tunnel} /> : null}
      <fieldset className="share-dialog-roles" disabled={busy}>
        <legend className="share-dialog-legend">Anyone with the link</legend>
        {REVIEW_ROLES.map((opt) => (
          <div key={opt.id} className="share-dialog-role">
            <input
              id={`${roleName}-${opt.id}`}
              type="radio"
              name={roleName}
              value={opt.id}
              checked={role === opt.id}
              aria-describedby={`${roleName}-${opt.id}-description`}
              onChange={() => onRoleChange(opt.id)}
            />
            <label
              className="share-dialog-role-name"
              htmlFor={`${roleName}-${opt.id}`}
            >
              {opt.label}
            </label>
            <span
              id={`${roleName}-${opt.id}-description`}
              className="share-dialog-role-description"
            >
              {opt.description}
            </span>
          </div>
        ))}
      </fieldset>
      <p className="share-dialog-note">
        Everyone with the link sees your cursor, selection, playhead, and
        viewport while they are in the session.
      </p>
      <div className="share-dialog-mcp">
        <label className="share-dialog-check" htmlFor={mcpId}>
          <input
            id={mcpId}
            type="checkbox"
            checked={withMcp}
            disabled={busy}
            aria-describedby={mcpHelpId}
            onChange={(e) => onWithMcpChange(e.target.checked)}
          />
          Allow AI assistants (MCP)
        </label>
        <p id={mcpHelpId} className="share-dialog-note share-dialog-mcp-help">
          {MCP_HELP}
        </p>
      </div>
      <section aria-labelledby={reviewLinksHeadingId}>
        <h3
          ref={reviewHeadingRef}
          className="share-dialog-heading"
          id={reviewLinksHeadingId}
          tabIndex={-1}
        >
          Review links
        </h3>
        <p className="share-dialog-note share-dialog-section-note">
          Links don't expire. Stop sharing turns one off.
        </p>
        {reviewLive.length === 0 ? (
          <EmptyState>No review links yet.</EmptyState>
        ) : (
          <ul className="share-dialog-list">
            {reviewLive.map((row) => {
              const target: PendingEnd = { kind: "link", token: row.token };
              return (
                <ReviewLinkRow
                  key={row.token}
                  {...props}
                  row={row}
                  confirming={
                    pending?.kind === "link" && pending.token === row.token
                  }
                  onAskStop={() => setPending(target)}
                  stopRef={endTrigger(target)}
                  onKeep={keep}
                  onConfirm={confirmEnd}
                />
              );
            })}
          </ul>
        )}
      </section>
      <section aria-labelledby={recordRoomsHeadingId}>
        <h3
          ref={roomsHeadingRef}
          className="share-dialog-heading"
          id={recordRoomsHeadingId}
          tabIndex={-1}
        >
          Record rooms
        </h3>
        <p className="share-dialog-note share-dialog-section-note">
          A guest link records the person who joins. A producer link lets your
          producer listen and comment without being recorded. Record links don't
          expire. End room turns them off.
        </p>
        {recordRooms.length === 0 ? (
          <EmptyState>No record rooms yet.</EmptyState>
        ) : (
          <ul className="share-dialog-list">
            {recordRooms.map((room) => {
              const target: PendingEnd = {
                kind: "room",
                sessionId: room.sessionId,
              };
              return (
                <RecordRoomCard
                  key={room.sessionId}
                  {...props}
                  room={room}
                  confirming={
                    pending?.kind === "room" &&
                    pending.sessionId === room.sessionId
                  }
                  onAskEnd={() => setPending(target)}
                  endRef={endTrigger(target)}
                  onKeep={keep}
                  onConfirm={confirmEnd}
                />
              );
            })}
          </ul>
        )}
        <div className="share-dialog-section-actions">
          <Button type="button" disabled={busy} onClick={onCreateRecord}>
            Create record links
          </Button>
        </div>
      </section>
    </div>
  );
}

type ConfirmProps = {
  confirming: boolean;
  onKeep: () => void;
  onConfirm: () => void;
};

function ReviewLinkRow({
  row,
  busy,
  copiedKey,
  onCopy,
  confirming,
  onAskStop,
  stopRef,
  onKeep,
  onConfirm,
}: ShareDialogViewProps &
  ConfirmProps & {
    row: HostShareRow;
    onAskStop: () => void;
    stopRef: RefCallback<HTMLButtonElement>;
  }) {
  const labelId = useId();
  const role = roleLabel(row);
  return (
    <li className="share-dialog-row">
      <div className="share-dialog-row-main">
        <span id={labelId} className="share-dialog-row-title">
          {role} link
        </span>
        <span className="share-dialog-meta">{reviewMeta(row)}</span>
        <span className="share-dialog-address">{row.token}</span>
      </div>
      {confirming ? (
        <InlineConfirm
          prompt={`Stop sharing this ${role} link? Anyone using it loses access.`}
          keepLabel="Keep link"
          actionLabel="Stop sharing"
          disabled={busy}
          onKeep={onKeep}
          onConfirm={onConfirm}
        />
      ) : (
        <div className="share-dialog-row-actions">
          <Button
            type="button"
            disabled={busy || !row.url}
            aria-describedby={labelId}
            onClick={() => onCopy("link", row.token, "Link", row.url)}
          >
            {copiedKey === shareCopyKey("link", row.token)
              ? "Copied link"
              : "Copy link"}
          </Button>
          {row.mcp_url ? (
            <Button
              type="button"
              disabled={busy}
              aria-describedby={labelId}
              onClick={() => onCopy("mcp", row.token, "MCP URL", row.mcp_url)}
            >
              {copiedKey === shareCopyKey("mcp", row.token)
                ? "Copied MCP URL"
                : "Copy MCP URL"}
            </Button>
          ) : null}
          <Button
            ref={stopRef}
            variant="danger"
            type="button"
            className="share-dialog-danger"
            disabled={busy}
            aria-describedby={labelId}
            onClick={onAskStop}
          >
            Stop sharing
          </Button>
        </div>
      )}
    </li>
  );
}

function RecordRoomCard({
  room,
  busy,
  onOpenRoomPanel,
  confirming,
  onAskEnd,
  endRef,
  onKeep,
  onConfirm,
  ...props
}: ShareDialogViewProps &
  ConfirmProps & {
    room: RecordRoomGroup;
    onAskEnd: () => void;
    endRef: RefCallback<HTMLButtonElement>;
  }) {
  const labelId = useId();
  const created = room.guests[0]?.created_at ?? room.producers[0]?.created_at;
  return (
    <li className="share-dialog-row share-dialog-room">
      <div className="share-dialog-row-main">
        <span id={labelId} className="share-dialog-row-title">
          Record room
        </span>
        {created ? (
          <span className="share-dialog-meta">
            Created {formatWhen(created)}
          </span>
        ) : null}
      </div>
      {(room.guests.length === 0 ? [null] : room.guests).map((guest, index) => (
        <RoomLink
          key={guest?.token ?? `guest-missing-${index}`}
          {...props}
          busy={busy}
          link={guest}
          linkRole="guest"
          fallbackKey={room.sessionId}
        />
      ))}
      {(room.producers.length === 0 ? [null] : room.producers).map(
        (producer, index) => (
          <RoomLink
            key={producer?.token ?? `producer-missing-${index}`}
            {...props}
            busy={busy}
            link={producer}
            linkRole="producer"
            fallbackKey={`${room.sessionId}-producer`}
          />
        ),
      )}
      {confirming ? (
        <InlineConfirm
          prompt="End this record room? Both guest and producer links will stop working."
          keepLabel="Keep room"
          actionLabel="End room"
          disabled={busy}
          onKeep={onKeep}
          onConfirm={onConfirm}
        />
      ) : (
        <div className="share-dialog-row-actions share-dialog-room-actions">
          <Button
            type="button"
            disabled={busy}
            aria-describedby={labelId}
            onClick={onOpenRoomPanel}
          >
            Open room panel
          </Button>
          <Button
            ref={endRef}
            variant="danger"
            type="button"
            className="share-dialog-danger"
            disabled={busy}
            aria-describedby={labelId}
            onClick={onAskEnd}
          >
            End room
          </Button>
        </div>
      )}
    </li>
  );
}

const ROOM_LINK_COPY = {
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

function RoomLink({
  link,
  linkRole,
  fallbackKey,
  busy,
  copiedKey,
  onCopy,
  onReplaceRecordInvite,
}: Pick<
  ShareDialogViewProps,
  "busy" | "copiedKey" | "onCopy" | "onReplaceRecordInvite"
> & {
  link: HostShareRow | null;
  linkRole: keyof typeof ROOM_LINK_COPY;
  fallbackKey: string;
}) {
  const labelId = useId();
  const copy = ROOM_LINK_COPY[linkRole];
  const key = link?.token ?? fallbackKey;
  return (
    <div className="share-dialog-link">
      <div className="share-dialog-row-main">
        <span id={labelId} className="share-dialog-link-title">
          {link?.invite_closed ? copy.closed : copy.title}
        </span>
        <span className="share-dialog-address">
          {link
            ? link.token
            : "Missing. End this room and create new record links."}
        </span>
      </div>
      <div className="share-dialog-row-actions">
        <Button
          type="button"
          disabled={busy || !link?.url || !!link?.invite_closed}
          aria-describedby={labelId}
          onClick={() => onCopy("link", key, copy.copyLabel, link?.url ?? null)}
        >
          {copiedKey === shareCopyKey("link", key) ? copy.copied : copy.copy}
        </Button>
        {link?.invite_closed ? (
          <Button
            type="button"
            disabled={busy}
            onClick={() => onReplaceRecordInvite(link.token)}
          >
            {copy.replace}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
