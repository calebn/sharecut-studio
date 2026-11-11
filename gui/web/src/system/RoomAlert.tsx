import { AlertSlot } from "./AlertSlot";
import { roomAlertItems } from "./roomAlertItems";
import type { RoomAlertInput } from "./roomAlertModel";

export type RoomAlertProps = {
  /** Active alerts in any order. The most urgent shows; the rest sit behind "+N". */
  alerts: RoomAlertInput[];
};

/** The record room's alerts, ordered by the room's priority list, in the shared alert slot. */
export function RoomAlert({ alerts }: RoomAlertProps) {
  return <AlertSlot alerts={roomAlertItems(alerts)} />;
}
