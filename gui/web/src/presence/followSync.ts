import type {
  MobileMode,
  MoreDestination,
  ShellBreakpoint,
} from "../state/types";
import type {
  AuditionMode,
  PresenceCursor,
  PresenceTab,
  PresenceTransport,
  PresenceUi,
  PresenceViewport,
} from "../types/session";
import { MIN_VIEWPORT_SPAN_SEC } from "../utils/timelineZoom.generated";
import { clampZoomPxPerSec } from "../utils/zoom";

export { serverNowMs } from "./clock";

export function expectedPlayheadSec(
  t: PresenceTransport,
  serverNowMs: number,
  durationSec: number,
): number {
  const stampMs = (t.stamped_ns ?? 0) / 1e6;
  if (!Number.isFinite(t.playhead_sec) || !Number.isFinite(durationSec)) {
    return Number.NaN;
  }
  const raw = t.playing
    ? t.playhead_sec + ((serverNowMs - stampMs) / 1000) * (t.rate || 1)
    : t.playhead_sec;
  if (!Number.isFinite(raw)) {
    return Number.NaN;
  }
  return Math.max(0, Math.min(durationSec, raw));
}

export type Correction =
  | { action: "none" }
  | { action: "nudge"; rate: number }
  | { action: "seek"; toSec: number };

const DEFAULTS = { seekAboveMs: 250, nudgeAboveMs: 80, nudgeRate: 0.03 };

export type NudgeClock = { startedAt: number | null };

export function planCorrection(
  localSec: number,
  expectedSec: number,
  opts = DEFAULTS,
  nowMs = Date.now(),
  clock: NudgeClock = { startedAt: null },
): Correction {
  if (!Number.isFinite(localSec) || !Number.isFinite(expectedSec)) {
    return { action: "none" };
  }
  const driftMs = (expectedSec - localSec) * 1000;
  const abs = Math.abs(driftMs);
  if (abs > opts.seekAboveMs) {
    clock.startedAt = null;
    return { action: "seek", toSec: expectedSec };
  }
  if (abs > opts.nudgeAboveMs) {
    if (clock.startedAt == null) {
      clock.startedAt = nowMs;
    } else if (nowMs - clock.startedAt > 1000) {
      clock.startedAt = null;
      return { action: "seek", toSec: expectedSec };
    }
    const sign = driftMs > 0 ? 1 : -1;
    return { action: "nudge", rate: 1 + sign * opts.nudgeRate };
  }
  clock.startedAt = null;
  return { action: "none" };
}

/** Span published before the timeline has been measured. */
const UNMEASURED_VIEWPORT_SPAN_SEC = 60;

/**
 * Relative headroom over `MIN_VIEWPORT_SPAN_SEC` for a clamped span, so float
 * error can never land it under the server's `end - start < min` check
 * (`services/session_sync/commands.py`), which would drop the presence frame.
 */
const VIEWPORT_SPAN_FLOAT_MARGIN = 1e-6;

/**
 * The zoom and scroll that show a leader's viewport here. The leader may zoom
 * past this session's ceiling (another viewport width), so the zoom is clamped
 * to `sessionSec` and the scroll lands on their start at that zoom.
 */
export function viewportToZoomScroll(
  v: PresenceViewport,
  viewportWidthPx: number,
  sessionSec: number,
): { zoomPxPerSec: number; scrollLeft: number } {
  const span = Math.max(MIN_VIEWPORT_SPAN_SEC, v.end_sec - v.start_sec);
  const zoom = clampZoomPxPerSec(viewportWidthPx / span, sessionSec);
  return { zoomPxPerSec: zoom, scrollLeft: Math.max(0, v.start_sec * zoom) };
}

/**
 * The time window a logical scroll and zoom show. A padded fixed-playhead
 * view can scroll before 0: the window shifts to 0 instead of shrinking, so
 * followers keep one zoom and the server never sees a negative end.
 */
export function zoomScrollToViewport(
  scrollLeft: number,
  zoomPxPerSec: number,
  viewportWidthPx: number,
): PresenceViewport {
  const zoom = zoomPxPerSec > 0 ? zoomPxPerSec : 1;
  const span = Math.max(
    MIN_VIEWPORT_SPAN_SEC,
    viewportWidthPx > 0 ? viewportWidthPx / zoom : UNMEASURED_VIEWPORT_SPAN_SEC,
  );
  const start = Math.max(0, scrollLeft / zoom);
  const end = start + span;
  // Float addition can land a hair under the minimum (0.8 − 0.799 <
  // 0.001), and the server would drop the whole presence frame.
  return {
    start_sec: start,
    end_sec:
      end - start < MIN_VIEWPORT_SPAN_SEC
        ? start + MIN_VIEWPORT_SPAN_SEC * (1 + VIEWPORT_SPAN_FLOAT_MARGIN)
        : end,
  };
}

export function isObservingClient(client: {
  meta?: { following?: string | null } | null;
}): boolean {
  return Boolean(client.meta?.following);
}

export function isLiveClient(
  lastSeenNs: number | undefined,
  serverNowMs: number,
  maxAgeMs = 30_000,
): boolean {
  if (lastSeenNs == null) {
    return true;
  }
  const seenMs = lastSeenNs / 1e6;
  return serverNowMs - seenMs <= maxAgeMs;
}

export function isLocalPresenceClient(
  clientId: string,
  localId: string | null,
): boolean {
  if (!localId) {
    return false;
  }
  if (clientId === localId) {
    return true;
  }
  return clientId.startsWith("guest-") && clientId.endsWith(`-${localId}`);
}

export function remotePresenceClients<
  T extends { client_id: string; last_seen_ns?: number },
>(clients: T[], localId: string | null, serverNowMs: number): T[] {
  if (!localId) {
    return [];
  }
  return clients.filter(
    (c) =>
      !isLocalPresenceClient(c.client_id, localId) &&
      isLiveClient(c.last_seen_ns, serverNowMs),
  );
}

export function resolveFollowTarget<
  T extends {
    client_id: string;
    last_seen_ns?: number;
    meta?: { following?: string | null } | null;
  },
>(clients: T[], followingClientId: string, nowMs: number): T | null {
  const byId = new Map(clients.map((c) => [c.client_id, c]));
  const seen = new Set<string>();
  let id: string | null = followingClientId;
  while (id) {
    if (seen.has(id)) {
      return null;
    }
    seen.add(id);
    const client = byId.get(id);
    if (!client || !isLiveClient(client.last_seen_ns, nowMs)) {
      return null;
    }
    const next = client.meta?.following;
    if (typeof next === "string" && next) {
      id = next;
      continue;
    }
    return client;
  }
  return null;
}

let programmatic = 0;
let programmaticUi = 0;

export function withProgrammaticScroll(fn: () => void): void {
  programmatic += 1;
  try {
    fn();
  } finally {
    requestAnimationFrame(() => {
      programmatic -= 1;
    });
  }
}

export function isProgrammaticScroll(): boolean {
  return programmatic > 0;
}

export function withProgrammaticUi(fn: () => void): void {
  programmaticUi += 1;
  try {
    fn();
  } finally {
    programmaticUi -= 1;
  }
}

export function isProgrammaticUi(): boolean {
  return programmaticUi > 0;
}

export function setPresenceCursor(cursor: PresenceCursor | null): void {
  cursorSink?.(cursor);
}

type CursorSink = (cursor: PresenceCursor | null) => void;
let cursorSink: CursorSink | null = null;

export function setPresenceCursorSink(sink: CursorSink | null): void {
  cursorSink = sink;
}

export type FollowUiCaps = {
  guestShare: boolean;
  breakpoint: ShellBreakpoint;
};

export const HOST_ONLY_TABS: readonly PresenceTab[] = [
  "history",
  "impact",
  "tighten",
  "pipeline",
];

const HOST_ONLY_TAB_SET: ReadonlySet<PresenceTab> = new Set(HOST_ONLY_TABS);

const GUEST_TABS: readonly PresenceTab[] = ["transcript", "comments"];

const KNOWN_TABS: ReadonlySet<string> = new Set([
  ...GUEST_TABS,
  ...HOST_ONLY_TABS,
]);

export function studioTabIds(guestShare: boolean): PresenceTab[] {
  return guestShare ? [...GUEST_TABS] : [...GUEST_TABS, ...HOST_ONLY_TABS];
}

export function isHostOnlyTab(tab: string): boolean {
  return HOST_ONLY_TAB_SET.has(tab as PresenceTab);
}

export function tabAvailable(tab: PresenceTab, caps: FollowUiCaps): boolean {
  return !(caps.guestShare && HOST_ONLY_TAB_SET.has(tab));
}

export function mobileModeForTab(tab: PresenceTab): {
  mobileMode: MobileMode;
  moreDestination?: MoreDestination;
} {
  if (tab === "transcript") {
    return { mobileMode: "text" };
  }
  return { mobileMode: "more", moreDestination: tab };
}

export type FollowDegraded = { tab?: PresenceTab; audition?: "fx" | "raw" };

export function planFollowUi(
  leader: PresenceUi,
  caps: FollowUiCaps,
): {
  apply: {
    tab?: PresenceTab;
    mobile?: ReturnType<typeof mobileModeForTab>;
    audition?: AuditionMode;
    viewerMute?: Record<string, boolean>;
    soloTracks?: Record<string, boolean>;
  };
  degraded: FollowDegraded;
} {
  const apply: {
    tab?: PresenceTab;
    mobile?: ReturnType<typeof mobileModeForTab>;
    audition?: AuditionMode;
    viewerMute?: Record<string, boolean>;
    soloTracks?: Record<string, boolean>;
  } = {};
  const degraded: FollowDegraded = {};
  if (leader.tab && KNOWN_TABS.has(leader.tab)) {
    if (!tabAvailable(leader.tab, caps)) {
      degraded.tab = leader.tab;
    } else if (caps.breakpoint === "phone") {
      apply.mobile = phoneFollowMobile(leader);
    } else {
      apply.tab = leader.tab;
    }
  } else if (caps.breakpoint === "phone" && leader.mobile_mode) {
    apply.mobile = phoneFollowMobile(leader);
  }
  if (caps.guestShare) {
    apply.audition = "mix";
    if (leader.audition && leader.audition !== "mix") {
      degraded.audition = leader.audition;
    }
  } else if (leader.audition) {
    apply.audition = leader.audition;
  }
  if (!caps.guestShare) {
    if (leader.viewer_mute) {
      apply.viewerMute = Object.fromEntries(
        leader.viewer_mute.map((id) => [id, true]),
      );
    }
    if (leader.solo) {
      apply.soloTracks = Object.fromEntries(
        leader.solo.map((id) => [id, true]),
      );
    }
  }
  return { apply, degraded };
}

function phoneFollowMobile(
  leader: PresenceUi,
): ReturnType<typeof mobileModeForTab> {
  const mode = leader.mobile_mode;
  if (mode === "listen" || mode === "timeline" || mode === "text") {
    return { mobileMode: mode };
  }
  if (leader.tab) {
    return mobileModeForTab(leader.tab);
  }
  return { mobileMode: mode === "more" ? "more" : "text" };
}

export function followBannerDetail(
  d: FollowDegraded,
  tabLabel: (t: PresenceTab) => string,
): string {
  const bits: string[] = [];
  if (d.tab) {
    bits.push(`in ${tabLabel(d.tab)} (host-only)`);
  }
  if (d.audition) {
    bits.push(`auditioning ${d.audition.toUpperCase()}`);
  }
  return bits.length ? ` · ${bits.join(" · ")}` : "";
}
