import { useSyncExternalStore } from "react";

export type StorageArea = "snapshot" | "queue" | "prefs";
export type StorageCause = "blocked" | "full";
export type StorageHealth = Readonly<
  Partial<Record<StorageArea, StorageCause>>
>;

export const STORAGE_LIGHT = "Not kept on this device";
export const PREFS_SENTENCE =
  "This browser isn't keeping your settings. They reset when you reload.";

const SENTENCES: Record<StorageCause, string> = {
  blocked:
    "Your browser isn't letting this page keep a saved copy. The page still works while the host answers.",
  full: "This device has no room to keep a saved copy. The page still works while the host answers.",
};

export function storageSentence(cause: StorageCause): string {
  return SENTENCES[cause];
}

/** A failure that is not clearly blocked or full has to repeat before it is said. */
const OTHER_FAILURES_TO_SAY = 2;

export function classifyStorageError(
  error: unknown,
): "full" | "blocked" | "other" {
  const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
  if (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === 22 ||
    code === 1014
  )
    return "full";
  if (name === "SecurityError" || name === "InvalidStateError")
    return "blocked";
  return "other";
}

const listeners = new Set<() => void>();
let health: StorageHealth = {};
const otherFailures = new Map<StorageArea, number>();

function publish(next: StorageHealth): void {
  health = next;
  for (const listener of [...listeners]) listener();
}

/** Publishes only when what is said changes, so a poll that keeps failing says nothing new. */
export function reportStorageFailure(area: StorageArea, error: unknown): void {
  const kind = classifyStorageError(error);
  if (kind === "other") {
    const strikes = (otherFailures.get(area) ?? 0) + 1;
    otherFailures.set(area, strikes);
    if (strikes < OTHER_FAILURES_TO_SAY) return;
  }
  // A failure said after repeating is worded as blocked: the browser did not keep it and gave no better reason.
  const cause: StorageCause = kind === "full" ? "full" : "blocked";
  if (health[area] === cause) return;
  publish({ ...health, [area]: cause });
}

export function reportStorageOk(area: StorageArea): void {
  otherFailures.delete(area);
  if (health[area] === undefined) return;
  const { [area]: _cleared, ...rest } = health;
  publish(rest);
}

export function getStorageHealth(): StorageHealth {
  return health;
}

export function subscribeStorageHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forget every failure; for tests. */
export function resetStorageHealth(): void {
  otherFailures.clear();
  if (Object.keys(health).length > 0) publish({});
}

export function useStorageHealth(): StorageHealth {
  return useSyncExternalStore(subscribeStorageHealth, getStorageHealth);
}
