import { readLocal, writeLocal } from "./storage";

export type CoachTipId = "trim" | "selectionHandles" | "undo" | "rangeToggle";

export const COACH_TIPS: Record<CoachTipId, string> = {
  trim: "Drag the edges to trim",
  selectionHandles: "Drag the handles to adjust",
  undo: "Two-finger tap to undo",
  rangeToggle: "Drag across a lane to select",
};

export type CoachTipOwner = symbol;

const key = (id: CoachTipId) => `sharecut.coachTipSeen.${id}`;

/** Blocked storage costs a reload, never a repeat in the same session. */
const seenHere = new Set<CoachTipId>();

export function coachTipSeen(id: CoachTipId): boolean {
  return seenHere.has(id) || readLocal(key(id)) === "1";
}

export function markCoachTipSeen(id: CoachTipId): void {
  seenHere.add(id);
  writeLocal(key(id), "1");
}

let slot: { id: CoachTipId; owner: CoachTipOwner } | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function subscribeCoachTip(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function coachTipOwner(): CoachTipOwner | null {
  return slot?.owner ?? null;
}

export function showCoachTip(id: CoachTipId, owner: CoachTipOwner): boolean {
  if (slot !== null || coachTipSeen(id)) return false;
  slot = { id, owner };
  emit();
  return true;
}

export function dismissCoachTip(id: CoachTipId): void {
  markCoachTipSeen(id);
  if (slot?.id === id) {
    slot = null;
    emit();
  }
}

export function releaseCoachTip(owner: CoachTipOwner): void {
  if (slot?.owner !== owner) return;
  slot = null;
  emit();
}

/**
 * The toast id when a toast offers history Undo and is not the two-finger
 * gesture's own, else null. The one place that decides what teaches Undo.
 * Takes the fields of the store's `FeedbackToast` it reads.
 */
export function undoTipMoment(
  toast: { id: number; undo: string | null; gesture: boolean } | null,
): number | null {
  return toast !== null && toast.undo != null && !toast.gesture
    ? toast.id
    : null;
}

export function _resetCoachTipsForTests(): void {
  slot = null;
  seenHere.clear();
  emit();
}
