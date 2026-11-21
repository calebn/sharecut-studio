import { useSyncExternalStore } from "react";

export type HostCause = "device" | "host";

const AWAY_AFTER = 2;
/** How soon one failure is checked again, so a lone blip clears and a real loss confirms. */
const CONFIRM_MS = 1500;
const WHILE_AWAY_MS = 5000;

type HostReachSnapshot = {
  token: string | null;
  cause: HostCause | null;
  backSeq: number;
};

type Probe = (token: string) => Promise<unknown>;

const listeners = new Set<() => void>();
const backListeners = new Set<(token: string) => void>();

let probe: Probe | null = null;
let token: string | null = null;
let failures = 0;
let epoch = 0;
let away = false;
let backSeq = 0;
let probing = false;
let watchers = 0;
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
let awayTimer: ReturnType<typeof setInterval> | null = null;
let snapshot: HostReachSnapshot = { token: null, cause: null, backSeq: 0 };

function deviceOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function publish() {
  const cause: HostCause | null = away
    ? deviceOffline()
      ? "device"
      : "host"
    : null;
  if (
    snapshot.token === token &&
    snapshot.cause === cause &&
    snapshot.backSeq === backSeq
  ) {
    return;
  }
  snapshot = { token, cause, backSeq };
  for (const listener of [...listeners]) listener();
}

function stopTimers() {
  if (confirmTimer !== null) clearTimeout(confirmTimer);
  if (awayTimer !== null) clearInterval(awayTimer);
  confirmTimer = null;
  awayTimer = null;
}

function probeHostReach(): void {
  if (probe === null || token === null || probing || watchers === 0) return;
  const current = token;
  probing = true;
  void probe(current)
    .catch(() => undefined)
    .finally(() => {
      probing = false;
    });
}

function adopt(next: string) {
  if (token === next) return;
  stopTimers();
  token = next;
  failures = 0;
  away = false;
  probing = false;
  publish();
}

export function watchHostReach(): () => void {
  watchers += 1;
  return () => {
    watchers -= 1;
    if (watchers > 0) return;
    stopTimers();
    failures = 0;
    away = false;
    probing = false;
    publish();
  };
}

export function setHostReachProbe(next: Probe | null): void {
  probe = next;
}

/** Moves with every counted failure; a request notes it when it begins. */
export function hostReachEpoch(): number {
  return epoch;
}

/**
 * `startedAtEpoch` is `hostReachEpoch()` as the failed request began. A request
 * that began before a failure was counted belongs to that round and adds none.
 */
export function noteReviewTransportFailure(
  forToken: string,
  startedAtEpoch?: number,
): void {
  adopt(forToken);
  if (startedAtEpoch === undefined || startedAtEpoch === epoch) {
    failures += 1;
    epoch += 1;
  }
  const wasAway = away;
  if (!away && (failures >= AWAY_AFTER || deviceOffline())) {
    away = true;
    if (confirmTimer !== null) clearTimeout(confirmTimer);
    confirmTimer = null;
    awayTimer = setInterval(probeHostReach, WHILE_AWAY_MS);
    probeHostReach();
  } else if (!away && confirmTimer === null) {
    confirmTimer = setTimeout(() => {
      confirmTimer = null;
      probeHostReach();
    }, CONFIRM_MS);
  }
  if (away !== wasAway) publish();
}

export function noteReviewAnswer(forToken: string): void {
  adopt(forToken);
  failures = 0;
  stopTimers();
  if (!away) return;
  away = false;
  backSeq += 1;
  publish();
  for (const listener of [...backListeners]) listener(forToken);
}

export function resetHostReach(): void {
  stopTimers();
  token = null;
  failures = 0;
  away = false;
  backSeq = 0;
  probing = false;
  publish();
}

export function subscribeHostBack(
  listener: (token: string) => void,
): () => void {
  backListeners.add(listener);
  return () => {
    backListeners.delete(listener);
  };
}

function onBrowserLine() {
  publish();
  probeHostReach();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("online", onBrowserLine);
    window.addEventListener("offline", onBrowserLine);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("online", onBrowserLine);
      window.removeEventListener("offline", onBrowserLine);
    }
  };
}

const NOT_AWAY: HostReachSnapshot = { token: null, cause: null, backSeq: 0 };

function getSnapshot(): HostReachSnapshot {
  return snapshot;
}

export function useHostCause(forToken: string | null): HostCause | null {
  const current = useSyncExternalStore(subscribe, getSnapshot, () => NOT_AWAY);
  return current.token !== null && current.token === forToken
    ? current.cause
    : null;
}

export function hostCauseNow(forToken: string): HostCause | null {
  if (deviceOffline()) return "device";
  return snapshot.token === forToken ? snapshot.cause : null;
}

export function useHostBackCount(forToken: string | null): number {
  return useSyncExternalStore(
    subscribe,
    () =>
      snapshot.token !== null && snapshot.token === forToken
        ? snapshot.backSeq
        : 0,
    () => 0,
  );
}
