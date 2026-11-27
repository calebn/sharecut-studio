import type { ReadyRowData } from "./ReadyList";

/** The queued row whose button starts the run: the one step to take before anything runs. */
export function isStartRow(row: ReadyRowData): boolean {
  return row.state === "queued" && row.action?.run === "try-again";
}
