import type { ExecuteResult } from "./types";

type PendingDecider = (action: "approve" | "reject") => Promise<string | null>;

let current: { editId: string; decide: PendingDecider } | null = null;

export function registerPendingDecider(
  editId: string,
  decide: PendingDecider,
): () => void {
  const entry = { editId, decide };
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
