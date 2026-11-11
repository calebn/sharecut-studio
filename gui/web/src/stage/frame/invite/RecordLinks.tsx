import { useId } from "react";
import {
  formatWhen,
  type RecordRoomGroup,
  ROOM_LINK_COPY,
  type ShareOptions,
  shareCopyKey,
  shareRowsOf,
} from "../../../stages/deliver/shareLogic";
import type { HostShareRow } from "../../../types/shares";
import { Button, EmptyState } from "../../../ui";
import { BUSY_REASON } from "../../../ui/disabledReason";
import { copyReasonOf } from "./inviteLogic";

type EndProps = {
  options: ShareOptions;
  /** Ends one room at once; the toast the flow raises carries the Undo. */
  onEndRoom: (sessionId: string) => void;
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
  const busyReason = busy ? BUSY_REASON : undefined;
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
      <div className="inv-actions">
        <Button
          variant="danger"
          className="inv-danger"
          disabledReason={busyReason}
          aria-describedby={labelId}
          onClick={() => onEndRoom(room.sessionId)}
        >
          End room
        </Button>
      </div>
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
