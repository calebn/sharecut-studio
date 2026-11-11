import type { AlertSlotItem } from "./AlertSlot";
import {
  ROOM_ALERT_TEXT,
  type RoomAlertInput,
  roomAlertAction,
  roomAlertSecondary,
  roomAlertTitle,
  sortRoomAlerts,
} from "./roomAlertModel";

function itemOf(alert: RoomAlertInput): AlertSlotItem {
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

/** The room's alerts as slot rows: one per known kind, most urgent first. */
export function roomAlertItems(alerts: RoomAlertInput[]): AlertSlotItem[] {
  const { top, rest } = sortRoomAlerts(alerts);
  return top ? [top, ...rest].map(itemOf) : [];
}
