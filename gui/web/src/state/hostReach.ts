import { useSyncExternalStore } from "react";

/** Why the host cannot be reached: this device has no connection, or the host did not answer. */
export type HostCause = "device" | "host";

/** Consecutive transport failures that make a page away from its host. */
const AWAY_AFTER = 2;
/** How soon one failure is checked again, so a lone blip clears and a real loss confirms. */
const CONFIRM_MS = 1500;
/** How often an away page asks again, so it returns without a press. */
const WHILE_AWAY_MS = 5000;

export type HostReachSnapshot = {
  token: string | null;
  cause: HostCause | null;
  /** Counts each time the page was away and a request got an answer. */
  backSeq: number;
};

type Probe = (token: string) => Promise<unknown>;

const listeners = new Set<() => void>();
const backListeners = new Set<(token: string) => void>();

let probe: Probe | null = null;
let token: string | null = null;
let failures = 0;
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

/** One cheap request; its outcome reaches the store through the request layer. */
export function probeHostReach(): void {
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

/** An open page keeps asking while it is away; with no open page the cover's own retries ask. */
export function watchHostReach(): () => void {
  watchers += 1;
  return () => {
    watchers -= 1;
  };
}

/** Registered by the request layer, which owns the cheap request. */
export function setHostReachProbe(next: Probe | null): void {
  probe = next;
}

/** A review request got no answer: the transport failed or it timed out. */
export function noteReviewTransportFailure(forToken: string): void {
  adopt(forToken);
  failures += 1;
  const wasAway = away;
  if (!away && (failures >= AWAY_AFTER || deviceOffline())) {
    away = true;
    if (confirmTimer !== null) clearTimeout(confirmTimer);
    confirmTimer = null;
    awayTimer = setInterval(probeHostReach, WHILE_AWAY_MS);
  } else if (!away && confirmTimer === null) {
    confirmTimer = setTimeout(() => {
      confirmTimer = null;
      probeHostReach();
    }, CONFIRM_MS);
  }
  if (away !== wasAway) publish();
}

/** A review request got an HTTP answer, whatever its status. */
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

/** Called each time an away page is answered again. */
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

/** Whether this review page is away from its host; null while it is reached. */
export function useHostCause(forToken: string | null): HostCause | null {
  const current = useSyncExternalStore(subscribe, getSnapshot, () => NOT_AWAY);
  return current.token !== null && current.token === forToken
    ? current.cause
    : null;
}

/** How many times this page was away and then answered; changes only then. */
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
