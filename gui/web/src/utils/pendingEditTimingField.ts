export type PendingEditTimingEdge = "start" | "end";

export function pendingEditTimingFieldId(
  editId: string,
  edge: PendingEditTimingEdge,
): string {
  return `pending-${editId}-source-${edge}`;
}
