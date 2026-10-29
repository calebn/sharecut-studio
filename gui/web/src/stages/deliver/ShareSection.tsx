import { type RefCallback, useEffect, useId, useRef, useState } from "react";
import { LinkRow } from "../../system/LinkRow";
import { Skeleton } from "../../system/Skeleton";
import { type HostShareRow, REVIEW_ROLES } from "../../types/shares";
import {
  Button,
  EmptyState,
  InlineConfirm,
  InlineError,
  SegmentedControl,
  ToggleButton,
} from "../../ui";
import { BUSY_REASON, useDisabledReasonNote } from "../../ui/disabledReason";
import { cancelInlineConfirm } from "../../ui/inlineConfirmGate";
import { DeliverSection } from "./DeliverSection";
import {
  FREEZE_HELP,
  formatWhen,
  MCP_HELP,
  PRESENCE_NOTE,
  type RecordRoomGroup,
  ROOM_LINK_COPY,
  reachOf,
  reviewMeta,
  roleLabel,
  roleOf,
  type ShareEnd,
  type ShareOptions,
  shareCopyKey,
  shareEndKey,
  shareRowsOf,
} from "./shareLogic";
import { TunnelStatusLine } from "./TunnelStatusLine";

type Props = {
  options: ShareOptions;
  state?: "ready" | "loading";
};

/**
 * Review links and record rooms for the open project: who can open a link and
 * as what, the link just made, and the ones already out, each with its Stop
 * sharing. The link is made when Create is pressed; Copy only copies.
 */
export function ShareSection({ options, state: pageState = "ready" }: Props) {
  const {
    rows,
    loaded,
    choices,
    onChoices,
    busy,
    recovery,
    error,
    status,
    blockedKey,
    tunnel,
    blockedReason,
    onCreate,
    onRefreshMix,
    onCreateRecord,
    onEndRoom,
    onStop,
    focusRequested = false,
    onFocused,
  } = options;
  const create = useRef<HTMLButtonElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const roomsHeading = useRef<HTMLHeadingElement>(null);
  const reviewHeadingId = useId();
  const roomsHeadingId = useId();
  const mcpHelpId = useId();
  const freezeHelpId = useId();
  const [pending, setPending] = useState<ShareEnd | null>(null);
  const refocusKey = useRef<string | null>(null);
  const reason = useDisabledReasonNote(blockedReason);
  const { review, rooms } = shareRowsOf(rows);

  useEffect(() => {
    if (!focusRequested) return;
    const section = create.current?.closest("section");
    const target = create.current?.disabled
      ? section?.querySelector<HTMLElement>("button:not(:disabled)")
      : create.current;
    target?.focus();
    target?.scrollIntoView?.({ block: "nearest" });
    onFocused?.();
  }, [focusRequested, onFocused]);

  // A copy the browser refused leaves the link selected, ready for Mod+C.
  useEffect(() => {
    if (!blockedKey) return;
    const text = document.querySelector<HTMLElement>(
      ".sys-link-text[data-selected]",
    );
    const selection = window.getSelection?.();
    if (text && selection) selection.selectAllChildren(text);
  }, [blockedKey, rows]);

  // Escape keeps the link or room, as Keep does.
  const asking = pending !== null;
  useEffect(() => {
    if (!asking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (cancelInlineConfirm()) event.stopPropagation();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [asking]);

  if (pageState === "loading") {
    return (
      <DeliverSection title="Share">
        <Skeleton layout="list" rows={3} />
      </DeliverSection>
    );
  }

  const keep = () => {
    refocusKey.current = pending ? shareEndKey(pending) : null;
    setPending(null);
  };
  const trigger =
    (target: ShareEnd): RefCallback<HTMLButtonElement> =>
    (el) => {
      if (el && refocusKey.current === shareEndKey(target)) {
        refocusKey.current = null;
        el.focus();
      }
    };
  const confirm = () => {
    if (!pending) return;
    setPending(null);
    if (pending.kind === "link") {
      onStop(pending.token);
      reviewHeading.current?.focus();
    } else {
      onEndRoom(pending.sessionId);
      roomsHeading.current?.focus();
    }
  };
  const busyReason = busy ? BUSY_REASON : undefined;
  const createReason = busyReason ?? blockedReason;
  const role = REVIEW_ROLES.find((r) => r.id === choices.role);

  return (
    <DeliverSection title="Share">
      {tunnel ? <TunnelStatusLine status={tunnel} /> : null}
      <div className="dv-field">
        <span className="dv-field-label">Anyone with the link</span>
        <SegmentedControl label="Anyone with the link">
          {REVIEW_ROLES.map((opt) => (
            <ToggleButton
              key={opt.id}
              quiet
              pressed={choices.role === opt.id}
              disabledReason={busyReason}
              onClick={() => onChoices({ ...choices, role: opt.id })}
            >
              {opt.label}
            </ToggleButton>
          ))}
        </SegmentedControl>
      </div>
      <p className="dv-note">{role?.description}</p>
      <div className="dv-chips" role="group" aria-label="Link options">
        <ToggleButton
          pressed={choices.withMcp}
          disabledReason={busyReason}
          aria-describedby={mcpHelpId}
          onClick={() => onChoices({ ...choices, withMcp: !choices.withMcp })}
        >
          Allow AI assistants (MCP)
        </ToggleButton>
        <ToggleButton
          pressed={choices.freeze}
          disabledReason={busyReason}
          aria-describedby={freezeHelpId}
          onClick={() => onChoices({ ...choices, freeze: !choices.freeze })}
        >
          Freeze on the current version
        </ToggleButton>
      </div>
      <p id={mcpHelpId} className="dv-note">
        {MCP_HELP}
      </p>
      <p id={freezeHelpId} className="dv-note">
        {FREEZE_HELP}
      </p>
      <p className="dv-note">{PRESENCE_NOTE}</p>

      {recovery.kind === "needs_refresh" ? (
        <div className="dv-share-recovery">
          <p role="alert" className="dv-note">
            {recovery.message}
          </p>
          <Button disabledReason={busyReason} onClick={onRefreshMix}>
            Refresh mix
          </Button>
          {recovery.refreshError ? (
            <p className="dv-note">Refresh failed: {recovery.refreshError}</p>
          ) : null}
        </div>
      ) : null}
      <div className="dv-primary dv-share-primary">
        <Button
          ref={create}
          variant="primary"
          disabledReason={createReason}
          {...(busy ? {} : reason.describedBy)}
          onClick={onCreate}
        >
          Create review link
        </Button>
        {reason.note}
      </div>
      <div className="dv-share-feedback" aria-live="polite">
        {error ? <InlineError message={error} /> : null}
        {!error && recovery.kind === "refreshing" ? (
          <p className="dv-note">Refreshing mix preview…</p>
        ) : null}
        {!error && recovery.kind === "retrying" ? (
          <p className="dv-note">Mix refreshed. Creating review link…</p>
        ) : null}
        {status && !error && recovery.kind === "idle" ? (
          <p className="dv-note">{status}</p>
        ) : null}
      </div>

      <h3
        ref={reviewHeading}
        id={reviewHeadingId}
        className="dv-share-heading"
        tabIndex={-1}
      >
        Review links
      </h3>
      <p className="dv-note">Links don't expire. Stop sharing turns one off.</p>
      {review.length === 0 ? (
        <EmptyState>
          {loaded
            ? "No review links yet."
            : error
              ? "Could not list your links."
              : "Looking for your links…"}
        </EmptyState>
      ) : (
        <ul className="dv-share-list" aria-labelledby={reviewHeadingId}>
          {review.map((row) => {
            const target: ShareEnd = { kind: "link", token: row.token };
            return (
              <ReviewRow
                key={row.token}
                row={row}
                options={options}
                confirming={
                  pending?.kind === "link" && pending.token === row.token
                }
                onAskStop={() => setPending(target)}
                stopRef={trigger(target)}
                onKeep={keep}
                onConfirm={confirm}
              />
            );
          })}
        </ul>
      )}

      <h3
        ref={roomsHeading}
        id={roomsHeadingId}
        className="dv-share-heading"
        tabIndex={-1}
      >
        Record rooms
      </h3>
      <p className="dv-note">
        A guest link records the person who joins. A producer link lets your
        producer listen and comment without being recorded. Record links don't
        expire. End room turns them off.
      </p>
      {rooms.length === 0 ? (
        <EmptyState>
          {loaded
            ? "No record rooms yet."
            : error
              ? "Could not list your rooms."
              : "Looking for your rooms…"}
        </EmptyState>
      ) : (
        <ul className="dv-share-list" aria-labelledby={roomsHeadingId}>
          {rooms.map((room) => {
            const target: ShareEnd = {
              kind: "room",
              sessionId: room.sessionId,
            };
            return (
              <RoomCard
                key={room.sessionId}
                room={room}
                options={options}
                confirming={
                  pending?.kind === "room" &&
                  pending.sessionId === room.sessionId
                }
                onAskEnd={() => setPending(target)}
                endRef={trigger(target)}
                onKeep={keep}
                onConfirm={confirm}
              />
            );
          })}
        </ul>
      )}
      <div className="dv-primary">
        <Button disabledReason={createReason} onClick={onCreateRecord}>
          Create record links
        </Button>
      </div>
    </DeliverSection>
  );
}

type ConfirmProps = {
  options: ShareOptions;
  confirming: boolean;
  onKeep: () => void;
  onConfirm: () => void;
};

function ReviewRow({
  row,
  options,
  confirming,
  onAskStop,
  stopRef,
  onKeep,
  onConfirm,
}: ConfirmProps & {
  row: HostShareRow;
  onAskStop: () => void;
  stopRef: RefCallback<HTMLButtonElement>;
}) {
  const { busy, copiedKey, blockedKey, tunnel, onCopy } = options;
  const labelId = useId();
  const role = roleLabel(row);
  const key = shareCopyKey("link", row.token);
  const busyReason = busy ? BUSY_REASON : undefined;
  return (
    <li className="dv-share-row">
      <LinkRow
        access={roleOf(row)}
        link={row.url}
        linkName={`${role} link`}
        placeholder="This link has no address to copy yet."
        copyState={
          copiedKey === key ? "copied" : blockedKey === key ? "blocked" : "idle"
        }
        reach={reachOf(tunnel, row.url)}
        note={reviewMeta(row)}
        compact={false}
        disabledReason={
          busyReason ??
          (row.url ? undefined : "This link has no address to copy yet.")
        }
        onCopy={() => onCopy("link", row.token, "Link", row.url)}
      />
      <span id={labelId} className="dv-share-address sys-mono">
        {row.token}
      </span>
      {confirming ? (
        <InlineConfirm
          prompt={`Stop sharing this ${role} link? Anyone using it loses access.`}
          keepLabel="Keep link"
          actionLabel="Stop sharing"
          disabledReason={busyReason}
          onKeep={onKeep}
          onConfirm={onConfirm}
        />
      ) : (
        <div className="dv-share-actions">
          {row.mcp_url ? (
            <Button
              disabledReason={busyReason}
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
            className="dv-share-danger"
            disabledReason={busyReason}
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

function RoomCard({
  room,
  options,
  confirming,
  onAskEnd,
  endRef,
  onKeep,
  onConfirm,
}: ConfirmProps & {
  room: RecordRoomGroup;
  onAskEnd: () => void;
  endRef: RefCallback<HTMLButtonElement>;
}) {
  const { busy, onOpenRecord } = options;
  const labelId = useId();
  const busyReason = busy ? BUSY_REASON : undefined;
  const created = room.guests[0]?.created_at ?? room.producers[0]?.created_at;
  return (
    <li className="dv-share-row">
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
            onClick={onOpenRecord}
          >
            Open Record stage
          </Button>
          <Button
            ref={endRef}
            variant="danger"
            className="dv-share-danger"
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
  const { busy, copiedKey, onCopy, onReplaceInvite } = options;
  const labelId = useId();
  const copy = ROOM_LINK_COPY[linkRole];
  const key = shareCopyKey("link", link?.token ?? fallbackKey);
  const busyReason = busy ? BUSY_REASON : undefined;
  const copyReason =
    busyReason ??
    (link?.invite_closed
      ? "This invite is closed. Replace it to share a new link."
      : !link?.url
        ? "This link has no address to copy yet."
        : undefined);
  return (
    <div className="dv-share-link">
      <div className="dv-share-main">
        <span id={labelId} className="dv-share-title">
          {link?.invite_closed ? copy.closed : copy.title}
        </span>
        <span className="dv-share-address sys-mono">
          {link
            ? link.token
            : "Missing. End this room and create new record links."}
        </span>
      </div>
      <div className="dv-share-actions">
        <Button
          disabledReason={copyReason}
          aria-describedby={labelId}
          onClick={() =>
            onCopy(
              "link",
              link?.token ?? fallbackKey,
              copy.copyLabel,
              link?.url ?? null,
            )
          }
        >
          {copiedKey === key ? copy.copied : copy.copy}
        </Button>
        {link?.invite_closed ? (
          <Button
            disabledReason={busyReason}
            onClick={() => onReplaceInvite(link.token)}
          >
            {copy.replace}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
