import { type RefCallback, useEffect, useId, useRef, useState } from "react";
import { LinkRow } from "../../system/LinkRow";
import type { LinkRole } from "../../system/linkRoles";
import { Skeleton } from "../../system/Skeleton";
import { type HostShareRow, REVIEW_ROLES } from "../../types/shares";
import { Button, EmptyState, InlineConfirm, InlineError } from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";
import { DeliverSection } from "./DeliverSection";
import {
  formatWhen,
  groupRecordRooms,
  type PendingEnd,
  pendingKey,
  type RecordRoomGroup,
  reviewMeta,
  SHARE_FREEZE_HELP,
  SHARE_MCP_HELP,
  type ShareOptions,
  shareCopyKey,
  shareRoleLabel,
} from "./shareLogic";
import { TunnelStatusLine } from "./TunnelStatusLine";

type Props = {
  options: ShareOptions;
  state?: "ready" | "loading";
  layout?: "desktop" | "phone";
  /** Marks Copy as the follow-up to an export. */
  highlight?: boolean;
};

type ConfirmProps = {
  confirming: boolean;
  onKeep: () => void;
  onConfirm: () => void;
};

const NO_ADDRESS = "This link has no address to copy yet.";

/** The host's listen links: who they let in, the ones out, and the record rooms. */
export function ShareSection({
  options,
  state: pageState = "ready",
  layout = "desktop",
  highlight = false,
}: Props) {
  const {
    role,
    onRole,
    withMcp,
    onWithMcp,
    freeze,
    onFreeze,
    rows,
    busy,
    createRecovery,
    error,
    status,
    copiedKey,
    lastCreated,
    tunnel,
    onCreate,
    onRefreshMix,
    onCreateRecord,
    onCopy,
    onRevoke,
    onEndRoom,
    focusRequested = false,
    onFocused,
  } = options;
  const roleName = useId();
  const mcpId = useId();
  const mcpHelpId = useId();
  const freezeId = useId();
  const freezeHelpId = useId();
  const reviewLinksHeadingId = useId();
  const recordRoomsHeadingId = useId();
  const createRef = useRef<HTMLButtonElement>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const roomsHeadingRef = useRef<HTMLHeadingElement>(null);
  const [pending, setPending] = useState<PendingEnd | null>(null);
  const refocusKey = useRef<string | null>(null);

  useEffect(() => {
    if (!focusRequested) return;
    createRef.current?.focus();
    createRef.current?.scrollIntoView?.({ block: "nearest" });
    onFocused?.();
  }, [focusRequested, onFocused]);

  useEffect(() => {
    if (!pending) return;
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      refocusKey.current = pendingKey(pending);
      setPending(null);
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [pending]);

  if (pageState === "loading") {
    return (
      <DeliverSection title="Share">
        <Skeleton layout="list" rows={3} />
      </DeliverSection>
    );
  }

  const live = rows.filter((row) => row.usable);
  const reviewLive = live.filter((row) => row.kind !== "record");
  const recordRooms = groupRecordRooms(
    live.filter((row) => row.kind === "record"),
  );
  const reCopy =
    lastCreated &&
    rows.some((row) => row.usable && row.token === lastCreated.token)
      ? lastCreated
      : null;
  const reCopyLabel = reCopy?.kind === "guest" ? "guest link" : "link";
  const busyReason = busy ? BUSY_REASON : undefined;

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
    if (!pending) return;
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
    <DeliverSection title="Share">
      {tunnel ? <TunnelStatusLine status={tunnel} /> : null}
      <fieldset className="dv-share-roles" disabled={busy}>
        <legend className="dv-field-label">Anyone with the link</legend>
        {REVIEW_ROLES.map((opt) => (
          <div key={opt.id} className="dv-share-option">
            <input
              id={`${roleName}-${opt.id}`}
              type="radio"
              name={roleName}
              value={opt.id}
              checked={role === opt.id}
              aria-describedby={`${roleName}-${opt.id}-description`}
              onChange={() => onRole(opt.id)}
            />
            <label
              className="dv-share-option-name"
              htmlFor={`${roleName}-${opt.id}`}
            >
              {opt.label}
            </label>
            <span id={`${roleName}-${opt.id}-description`} className="dv-note">
              {opt.description}
            </span>
          </div>
        ))}
      </fieldset>
      <p className="dv-note">
        Everyone with the link sees your cursor, selection, playhead, and
        viewport while they are in the session.
      </p>
      <div className="dv-share-option">
        <input
          id={mcpId}
          type="checkbox"
          checked={withMcp}
          disabled={busy}
          aria-describedby={mcpHelpId}
          onChange={(e) => onWithMcp(e.target.checked)}
        />
        <label className="dv-share-option-name" htmlFor={mcpId}>
          Allow AI assistants (MCP)
        </label>
        <span id={mcpHelpId} className="dv-note">
          {SHARE_MCP_HELP}
        </span>
      </div>
      <div className="dv-share-option">
        <input
          id={freezeId}
          type="checkbox"
          checked={freeze}
          disabled={busy}
          aria-describedby={freezeHelpId}
          onChange={(e) => onFreeze(e.target.checked)}
        />
        <label className="dv-share-option-name" htmlFor={freezeId}>
          Freeze on the current version
        </label>
        <span id={freezeHelpId} className="dv-note">
          {SHARE_FREEZE_HELP}
        </span>
      </div>

      {createRecovery.kind === "needs_refresh" ? (
        <div className="dv-share-recovery">
          <p role="alert">{createRecovery.message}</p>
          <Button disabledReason={busyReason} onClick={onRefreshMix}>
            Refresh mix
          </Button>
          {createRecovery.refreshError ? (
            <p>Refresh failed: {createRecovery.refreshError}</p>
          ) : null}
        </div>
      ) : null}
      <div className="dv-primary dv-share-create">
        <Button
          ref={createRef}
          variant="primary"
          disabledReason={busyReason}
          onClick={onCreate}
        >
          Create review link
        </Button>
        {reCopy ? (
          <Button
            disabledReason={busyReason}
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
      </div>
      <div className="dv-share-feedback" aria-live="polite">
        {error ? <InlineError message={error} /> : null}
        {!error && createRecovery.kind === "refreshing" ? (
          <p className="dv-note">Refreshing mix preview…</p>
        ) : null}
        {!error && createRecovery.kind === "retrying" ? (
          <p className="dv-note">Mix refreshed. Creating review link…</p>
        ) : null}
        {status && !error && createRecovery.kind === "idle" ? (
          <p className="dv-note">{status}</p>
        ) : null}
      </div>

      <section
        aria-labelledby={reviewLinksHeadingId}
        className="dv-share-group"
      >
        <h3
          ref={reviewHeadingRef}
          className="dv-share-heading"
          id={reviewLinksHeadingId}
          tabIndex={-1}
        >
          Review links
        </h3>
        <p className="dv-note">
          Links don't expire. Stop sharing turns one off.
        </p>
        {reviewLive.length === 0 ? (
          <EmptyState>No review links yet.</EmptyState>
        ) : (
          <ul className="dv-share-list">
            {reviewLive.map((row) => {
              const target: PendingEnd = { kind: "link", token: row.token };
              return (
                <ReviewLinkRow
                  key={row.token}
                  options={options}
                  row={row}
                  phone={layout === "phone"}
                  highlight={highlight}
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

      <section
        aria-labelledby={recordRoomsHeadingId}
        className="dv-share-group"
      >
        <h3
          ref={roomsHeadingRef}
          className="dv-share-heading"
          id={recordRoomsHeadingId}
          tabIndex={-1}
        >
          Record rooms
        </h3>
        <p className="dv-note">
          A guest link records the person who joins. A producer link lets your
          producer listen and comment without being recorded. Record links don't
          expire. End room turns them off.
        </p>
        {recordRooms.length === 0 ? (
          <EmptyState>No record rooms yet.</EmptyState>
        ) : (
          <ul className="dv-share-list">
            {recordRooms.map((room) => {
              const target: PendingEnd = {
                kind: "room",
                sessionId: room.sessionId,
              };
              return (
                <RecordRoomCard
                  key={room.sessionId}
                  options={options}
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
        <div className="dv-primary">
          <Button disabledReason={busyReason} onClick={onCreateRecord}>
            Create record links
          </Button>
        </div>
      </section>
    </DeliverSection>
  );
}

function ReviewLinkRow({
  options,
  row,
  phone,
  highlight,
  confirming,
  onAskStop,
  stopRef,
  onKeep,
  onConfirm,
}: ConfirmProps & {
  options: ShareOptions;
  row: HostShareRow;
  phone: boolean;
  highlight: boolean;
  onAskStop: () => void;
  stopRef: RefCallback<HTMLButtonElement>;
}) {
  const { busy, copiedKey, reach, onCopy } = options;
  const role = shareRoleLabel(row);
  const nameId = useId();
  const meta = reviewMeta(row);
  const busyReason = busy ? BUSY_REASON : undefined;
  const copied = copiedKey === shareCopyKey("link", row.token);
  const access: LinkRole = REVIEW_ROLES.some((r) => r.id === row.docs_role)
    ? (row.docs_role as LinkRole)
    : "viewer";
  return (
    <li className="dv-share-item">
      <LinkRow
        access={access}
        link={row.url}
        describedBy={nameId}
        note={
          <span className="dv-share-note">
            {meta ? <span>{meta}</span> : null}
            <span className="dv-share-address">{row.token}</span>
          </span>
        }
        reach={reach}
        compact={phone}
        highlight={highlight}
        emptyText={NO_ADDRESS}
        copyState={copied ? "copied" : "idle"}
        copyDisabledReason={busyReason ?? (row.url ? undefined : NO_ADDRESS)}
        onCopy={() => onCopy("link", row.token, "Link", row.url)}
        actions={
          <>
            <span id={nameId} className="sr-only">
              {role} link
            </span>
            {confirming ? null : (
              <>
                {row.mcp_url ? (
                  <Button
                    disabledReason={busyReason}
                    aria-describedby={nameId}
                    onClick={() =>
                      onCopy("mcp", row.token, "MCP URL", row.mcp_url)
                    }
                  >
                    {copiedKey === shareCopyKey("mcp", row.token)
                      ? "Copied MCP URL"
                      : "Copy MCP URL"}
                  </Button>
                ) : null}
                <Button
                  ref={stopRef}
                  variant="danger"
                  disabledReason={busyReason}
                  aria-describedby={nameId}
                  onClick={onAskStop}
                >
                  Stop sharing
                </Button>
              </>
            )}
          </>
        }
      />
      {confirming ? (
        <InlineConfirm
          prompt={`Stop sharing this ${role} link? Anyone using it loses access.`}
          keepLabel="Keep link"
          actionLabel="Stop sharing"
          disabledReason={busyReason}
          onKeep={onKeep}
          onConfirm={onConfirm}
        />
      ) : null}
    </li>
  );
}

function RecordRoomCard({
  options,
  room,
  confirming,
  onAskEnd,
  endRef,
  onKeep,
  onConfirm,
}: ConfirmProps & {
  options: ShareOptions;
  room: RecordRoomGroup;
  onAskEnd: () => void;
  endRef: RefCallback<HTMLButtonElement>;
}) {
  const { busy, onOpenRoomPanel } = options;
  const labelId = useId();
  const busyReason = busy ? BUSY_REASON : undefined;
  const created = room.guests[0]?.created_at ?? room.producers[0]?.created_at;
  return (
    <li className="dv-share-item dv-share-room">
      <div className="dv-share-main">
        <span id={labelId} className="dv-share-title">
          Record room
        </span>
        {created ? (
          <span className="dv-note">Created {formatWhen(created)}</span>
        ) : null}
      </div>
      {(room.guests.length === 0 ? [null] : room.guests).map((guest, index) => (
        <RoomLink
          key={guest?.token ?? `guest-missing-${index}`}
          options={options}
          link={guest}
          linkRole="guest"
          fallbackKey={room.sessionId}
        />
      ))}
      {(room.producers.length === 0 ? [null] : room.producers).map(
        (producer, index) => (
          <RoomLink
            key={producer?.token ?? `producer-missing-${index}`}
            options={options}
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
          disabledReason={busyReason}
          onKeep={onKeep}
          onConfirm={onConfirm}
        />
      ) : (
        <div className="dv-share-actions">
          <Button
            disabledReason={busyReason}
            aria-describedby={labelId}
            onClick={onOpenRoomPanel}
          >
            Open room panel
          </Button>
          <Button
            ref={endRef}
            variant="danger"
            disabledReason={busyReason}
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
  options,
  link,
  linkRole,
  fallbackKey,
}: {
  options: ShareOptions;
  link: HostShareRow | null;
  linkRole: keyof typeof ROOM_LINK_COPY;
  fallbackKey: string;
}) {
  const { busy, copiedKey, onCopy, onReplaceRecordInvite } = options;
  const labelId = useId();
  const copy = ROOM_LINK_COPY[linkRole];
  const key = link?.token ?? fallbackKey;
  const busyReason = busy ? BUSY_REASON : undefined;
  return (
    <div className="dv-share-link">
      <div className="dv-share-main">
        <span id={labelId} className="dv-share-title">
          {link?.invite_closed ? copy.closed : copy.title}
        </span>
        <span className="dv-share-address">
          {link
            ? link.token
            : "Missing. End this room and create new record links."}
        </span>
      </div>
      <div className="dv-share-actions">
        <Button
          disabledReason={
            busyReason ??
            (link?.invite_closed
              ? "This invite is closed. Replace it to share a new link."
              : !link?.url
                ? NO_ADDRESS
                : undefined)
          }
          aria-describedby={labelId}
          onClick={() => onCopy("link", key, copy.copyLabel, link?.url ?? null)}
        >
          {copiedKey === shareCopyKey("link", key) ? copy.copied : copy.copy}
        </Button>
        {link?.invite_closed ? (
          <Button
            disabledReason={busyReason}
            onClick={() => onReplaceRecordInvite(link.token)}
          >
            {copy.replace}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
