import { useEffect, useId, useRef, useState } from "react";
import {
  endRoomCheck,
  endRoomPrompt,
  useHostRoomReader,
  useHostRoomSelector,
  useRecordHostStore,
} from "../../../record";
import {
  formatWhen,
  type RecordRoomGroup,
  ROOM_LINK_COPY,
  type ShareOptions,
  shareCopyKey,
  shareRowsOf,
} from "../../../stages/deliver/shareLogic";
import type { HostShareRow } from "../../../types/shares";
import {
  Button,
  EmptyState,
  InlineConfirm,
  registerInlineConfirm,
} from "../../../ui";
import { BUSY_REASON, useDisabledReasonNote } from "../../../ui/disabledReason";
import { copyReasonOf } from "./inviteLogic";

type EndProps = {
  options: ShareOptions;
  /** Ends one room; the toast the flow raises carries the Undo. False when the press was ignored. */
  onEndRoom: (sessionId: string) => boolean | void;
};

/** The record rooms of the project, each with its guest and producer links and End room, and Create record links. */
export function RecordLinks({
  labelledBy,
  ...props
}: EndProps & { labelledBy: string }) {
  const { options } = props;
  const { rooms } = shareRowsOf(options.rows);
  return (
    <>
      {rooms.length === 0 ? (
        <EmptyState>
          {options.listFailed
            ? "Could not list your rooms."
            : options.loaded
              ? "No record rooms yet."
              : "Looking for your rooms…"}
        </EmptyState>
      ) : (
        <ul className="inv-list" aria-labelledby={labelledBy}>
          {rooms.map((room) => (
            <RoomCard key={room.sessionId} room={room} {...props} />
          ))}
        </ul>
      )}
      <div className="inv-actions">
        <Button
          disabledReason={copyReasonOf(options)}
          onClick={options.onCreateRecord}
        >
          Create record links
        </Button>
        {rooms.length > 0 && options.onOpenRecord ? (
          <Button
            disabledReason={options.busy ? BUSY_REASON : undefined}
            onClick={options.onOpenRecord}
          >
            Open Record stage
          </Button>
        ) : null}
      </div>
    </>
  );
}

function RoomCard({
  room,
  options,
  onEndRoom,
}: EndProps & { room: RecordRoomGroup }) {
  const { busy } = options;
  const labelId = useId();
  const endButton = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState(false);
  const snapshot = useRecordHostStore((s) => s.snapshot);
  const segments = useHostRoomSelector(
    (r) => r?.hostSegments ?? null,
    Object.is,
  );
  const readHostRoom = useHostRoomReader();
  const check = endRoomCheck(snapshot, segments, room.sessionId);
  const busyReason = busy ? BUSY_REASON : undefined;
  const endReason = check.kind === "blocked" ? check.reason : busyReason;
  const endNote = useDisabledReasonNote(endReason, "inv-note");
  const checkNow = () =>
    endRoomCheck(
      useRecordHostStore.getState().snapshot,
      readHostRoom()?.hostSegments ?? null,
      room.sessionId,
    );
  const refocus = useRef(false);
  const closeAsk = () => {
    refocus.current = true;
    setAsking(false);
  };
  useEffect(() => {
    if (asking || !refocus.current) return;
    refocus.current = false;
    endButton.current?.focus({ preventScroll: true });
  }, [asking]);
  const stillAsks = check.kind === "ask";
  useEffect(() => {
    if (asking && !stillAsks) setAsking(false);
  }, [asking, stillAsks]);
  useEffect(() => {
    if (!asking || !busy) return;
    return registerInlineConfirm(closeAsk);
  }, [asking, busy]);
  const ask = asking && check.kind === "ask";
  const end = () => {
    if (checkNow().kind === "blocked") {
      setAsking(false);
      return;
    }
    onEndRoom(room.sessionId);
    setAsking(false);
  };
  const onEndClick = () => {
    const now = checkNow();
    if (now.kind === "ask") {
      setAsking(true);
      return;
    }
    if (now.kind === "now") onEndRoom(room.sessionId);
  };
  const created = room.guests[0]?.created_at ?? room.producers[0]?.created_at;
  return (
    <li className="inv-item inv-room">
      <div className="inv-room-main">
        <span id={labelId} className="inv-room-title">
          Record room
        </span>
        {created ? (
          <span className="inv-note">Created {formatWhen(created)}</span>
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
      {ask ? (
        <InlineConfirm
          prompt={endRoomPrompt(check.names)}
          keepLabel="Keep room"
          actionLabel="End room"
          disabledReason={busyReason}
          onKeep={closeAsk}
          onConfirm={end}
        />
      ) : (
        <div className="inv-actions">
          <Button
            ref={endButton}
            variant="danger"
            className="inv-danger"
            disabledReason={endReason}
            {...(endNote.describedBy["aria-describedby"]
              ? endNote.describedBy
              : { "aria-describedby": labelId })}
            onClick={onEndClick}
          >
            End room
          </Button>
        </div>
      )}
      {ask ? (
        busyReason ? (
          <p className="inv-note">{busyReason}</p>
        ) : null
      ) : (
        endNote.note
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
    <div className="inv-room-link">
      <div className="inv-room-main">
        <span id={labelId} className="inv-room-title">
          {link?.invite_closed ? copy.closed : copy.title}
        </span>
        <span className="inv-address sys-mono">
          {link
            ? link.token
            : "Missing. End this room and create new record links."}
        </span>
      </div>
      <div className="inv-actions">
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
