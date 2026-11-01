import type { ExecuteResult } from "./types";

type PendingDecider = (action: "approve" | "reject") => Promise<string | null>;

let current: {
  editId: string;
  decide: PendingDecider;
  busyReason: () => string | null;
} | null = null;

export function registerPendingDecider(
  editId: string,
  decide: PendingDecider,
  busyReason: () => string | null,
): () => void {
  const entry = { editId, decide, busyReason };
  current = entry;
  return () => {
    if (current === entry) current = null;
  };
}

export async function decideThroughSheet(
  editId: string,
  action: "approve" | "reject",
): Promise<ExecuteResult | null> {
  if (current?.editId !== editId) return null;
  const reason = await current.decide(action);
  return reason === null ? { status: "ok" } : { status: "disabled", reason };
}

export function sheetBusyReason(editId: string): string | null {
  return current?.editId === editId ? current.busyReason() : null;
}
