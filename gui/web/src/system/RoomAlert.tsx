import { AlertSlot, type AlertSlotItem } from "./AlertSlot";
import {
  ROOM_ALERT_TEXT,
  type RoomAlertInput,
  roomAlertAction,
  roomAlertSecondary,
  roomAlertTitle,
  sortRoomAlerts,
} from "./roomAlertModel";

export type RoomAlertProps = {
  /** Active alerts in any order. The most urgent shows; the rest sit behind "+N". */
  alerts: RoomAlertInput[];
};

function slotItemOf(alert: RoomAlertInput): AlertSlotItem {
  return {
    id: alert.kind,
    state: ROOM_ALERT_TEXT[alert.kind].state,
    title: roomAlertTitle(alert),
    titleRole: alert.kind === "room-tone-capturing" ? "timer" : undefined,
    progress: alert.progress,
    barLabel: alert.progress === undefined ? undefined : "Room tone",
    action: roomAlertAction(alert),
    secondaryAction: roomAlertSecondary(alert),
  };
}

/** The record room's alerts, ordered by the room's priority list, in the shared alert slot. */
export function RoomAlert({ alerts }: RoomAlertProps) {
  const { top, rest } = sortRoomAlerts(alerts);
  return <AlertSlot alerts={top ? [top, ...rest].map(slotItemOf) : []} />;
}
