import { useSyncExternalStore } from "react";
import { submitDiagnosticsReport } from "../../api";
import { referenceOf } from "./helpReport";

/**
 * The report waiting for a connection. It lives outside the sheet so closing
 * the sheet does not drop a report that was promised to send when online.
 */
export type Outbox =
  | { kind: "empty" }
  | { kind: "waiting"; filename: string; description: string }
  | { kind: "sending" }
  | { kind: "sent"; reference: string }
  | { kind: "failed" };

const EMPTY: Outbox = { kind: "empty" };

let state: Outbox = EMPTY;
const listeners = new Set<() => void>();

function set(next: Outbox): void {
  state = next;
  for (const listener of listeners) listener();
}

async function flush(): Promise<void> {
  if (state.kind !== "waiting") return;
  const { filename, description } = state;
  set({ kind: "sending" });
  try {
    const result = await submitDiagnosticsReport({
      filename,
      description,
      consent: true,
    });
    set({ kind: "sent", reference: referenceOf(result.status_url) });
  } catch {
    set({ kind: "failed" });
  }
}

let watching = false;

function watchConnection(): void {
  if (watching) return;
  watching = true;
  window.addEventListener("online", () => void flush());
}

export function outboxState(): Outbox {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function queueReport(filename: string, description: string): void {
  watchConnection();
  set({ kind: "waiting", filename, description });
}

/** Forgets a finished report; one still waiting or sending is kept. */
export function clearOutbox(): void {
  if (state.kind !== "waiting" && state.kind !== "sending") set(EMPTY);
}

export function useHelpOutbox(): Outbox {
  return useSyncExternalStore(subscribe, outboxState);
}
