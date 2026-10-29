import { useId, useRef, useState } from "react";
import { Button } from "../ui";
import {
  ROOM_ALERT_TEXT,
  type RoomAlertInput,
  roomAlertAction,
  roomAlertSecondary,
  roomAlertTitle,
  sortRoomAlerts,
} from "./roomAlertModel";
import { StatusList } from "./StatusList";
import { StatusRow } from "./StatusRow";
import { useFocusRescue } from "./useFocusRescue";

export type RoomAlertProps = {
  /** Active alerts in any order. The most urgent shows; the rest sit behind "+N". */
  alerts: RoomAlertInput[];
};

/**
 * The record alert slot: one 44 px Status row for the most urgent alert, a "+N"
 * chip for the rest, and the rest listed under it when opened. With no alert the
 * live region stays mounted and empty, so the slot takes no height. Only the top
 * row sits in the live region; the chip and the list are outside it.
 */
export function RoomAlert({ alerts }: RoomAlertProps) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const slot = useRef<HTMLDivElement>(null);
  const region = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  // When the top action goes, focus has nowhere to land: the chip if it is
  // still there, else the empty region itself.
  useFocusRescue(slot, () => () => chip.current ?? region.current);
  const { top, rest } = sortRoomAlerts(alerts);
  // The list closes by itself once nothing is left behind the chip.
  if (rest.length === 0 && expanded) setExpanded(false);
  const open = expanded && rest.length > 0;
  // A ticking line is not announced; the room's one-shot announcer speaks start and end.
  const ticking = top?.kind === "room-tone-capturing";
  const more = rest.length;
  return (
    <div className="sys-room-alert-slot" ref={slot}>
      <div className="sys-room-alert-row">
        <div
          ref={region}
          className="sys-room-alert-live"
          role="status"
          aria-live={ticking ? "off" : undefined}
          tabIndex={-1}
        >
          {top ? (
            <StatusRow
              state={ROOM_ALERT_TEXT[top.kind].state}
              title={roomAlertTitle(top)}
              density="alert"
              titleRole={ticking ? "timer" : undefined}
              progress={top.progress}
              barLabel={top.progress === undefined ? undefined : "Room tone"}
              action={roomAlertAction(top)}
              secondaryAction={roomAlertSecondary(top)}
            />
          ) : null}
        </div>
        {more > 0 ? (
          <Button
            ref={chip}
            className="sys-room-alert-more"
            aria-label={`${more} more ${more === 1 ? "alert" : "alerts"}`}
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setExpanded((value) => !value)}
          >
            {`+${more}`}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div id={listId}>
          <StatusList label="More alerts">
            {rest.map((alert) => (
              <StatusRow
                key={alert.kind}
                state={ROOM_ALERT_TEXT[alert.kind].state}
                title={roomAlertTitle(alert)}
                density="alert"
                titleRole={
                  alert.kind === "room-tone-capturing" ? "timer" : undefined
                }
                progress={alert.progress}
                barLabel={
                  alert.progress === undefined ? undefined : "Room tone"
                }
                action={roomAlertAction(alert)}
                secondaryAction={roomAlertSecondary(alert)}
              />
            ))}
          </StatusList>
        </div>
      ) : null}
    </div>
  );
}
