import { setTrackFaderCommand, setTrackMuteCommand } from "../api";
import { patchTrackMix } from "../document/projectPatch";
import { useDawStore } from "../state/dawStore";
import type { ProjectView, TrackView } from "../types/project";
import { errorMessage } from "../utils/apiError";
import { clampFaderDb, trackFaderDb } from "../utils/audio";
import { evaluateWhen } from "./context";
import { registerCommand } from "./execute";
import { resolveTrackId } from "./targets";
import type { ExecuteResult } from "./types";

/** M on a track muted in the mix, for a guest who can't edit it. */
export const SAVED_MUTE_READ_ONLY =
  "Muted in the mix. Only the host and editors can unmute it";

/**
 * A volume change waits this long for the next one, so a held arrow key or
 * a click then double-click saves one volume (one undo step), not dozens.
 */
export const VOLUME_SAVE_DELAY_MS = 300;

/**
 * How long a value the host queued behind another command stays shown over
 * server snapshots. The host drains its queue every 10 s, and the drained
 * command's reply then carries the value.
 */
const QUEUED_SHOWN_MS = 15_000;

type MixField = "fader_db" | "muted";
type MixValue = number | boolean;

/**
 * One saved field of one track. Its newest value is shown at once and kept
 * shown over server snapshots until the server has it; only the latest
 * value of a burst is sent.
 */
interface MixLane {
  projectPath: string;
  trackId: string;
  field: MixField;
  send: (projectPath: string, value: MixValue) => Promise<unknown>;
  /** The saved value a failure reverts to. */
  confirmed: MixValue;
  /** Newest value, not sent yet. */
  latest?: MixValue;
  /** Value being sent. */
  inFlight?: MixValue;
  /** Value the host queued behind another command, and until when to show it. */
  queued?: { value: MixValue; until: number };
  scheduled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  waiters: Array<(result: ExecuteResult) => void>;
}

const lanes = new Map<string, MixLane>();
/** Mix sends go one at a time, so two never overlap on the server. */
let sendChain: Promise<void> = Promise.resolve();
let unwatch: (() => void) | null = null;
let overlaying = false;
let pageHooked = false;

function readField(
  project: ProjectView | null,
  trackId: string,
  field: MixField,
): MixValue | undefined {
  const track = project?.tracks.find((t) => t.id === trackId);
  if (!track) {
    return undefined;
  }
  return field === "muted" ? track.muted : trackFaderDb(track);
}

function fieldsOf(
  field: MixField,
  value: MixValue,
): Partial<Pick<TrackView, MixField>> {
  return field === "muted"
    ? { muted: Boolean(value) }
    : { fader_db: Number(value) };
}

function pendingValue(lane: MixLane): MixValue | undefined {
  if (lane.latest !== undefined) {
    return lane.latest;
  }
  if (lane.inFlight !== undefined) {
    return lane.inFlight;
  }
  if (lane.queued && lane.queued.until > Date.now()) {
    return lane.queued.value;
  }
  return undefined;
}

/** A mix change the server hasn't mixed yet leaves the premix behind. */
function markPremixBehind(project: ProjectView): ProjectView {
  const premix = project.render_status.premix;
  if (!premix.exists || premix.stale_vs_mix) {
    return project;
  }
  return {
    ...project,
    render_status: {
      ...project.render_status,
      premix: { ...premix, stale_vs_mix: true },
    },
  };
}

/** Keep every unsaved mix value shown over whatever the server last sent. */
function overlayPending(): void {
  if (overlaying) {
    return;
  }
  const s = useDawStore.getState();
  let project = s.project;
  if (!project) {
    return;
  }
  const start = project;
  for (const [key, lane] of lanes) {
    if (lane.projectPath !== s.projectPath) {
      continue;
    }
    const shown = readField(project, lane.trackId, lane.field);
    const value = pendingValue(lane);
    if (value === undefined) {
      settle(key, lane);
      continue;
    }
    if (shown !== value) {
      project = patchTrackMix(
        project,
        lane.trackId,
        fieldsOf(lane.field, value),
      );
    }
    if (value !== lane.confirmed) {
      project = markPremixBehind(project);
    }
  }
  if (project !== start) {
    overlaying = true;
    try {
      s.setProject(project);
    } finally {
      overlaying = false;
    }
  }
}

function watchStore(): void {
  unwatch ??= useDawStore.subscribe((state, prev) => {
    if (state.project !== prev.project) {
      overlayPending();
    }
  });
}

/** Drop an idle lane; stop watching the store once none are left. */
function settle(key: string, lane: MixLane): void {
  if (
    pendingValue(lane) !== undefined ||
    lane.scheduled ||
    lane.timer !== undefined ||
    lanes.get(key) !== lane
  ) {
    return;
  }
  lanes.delete(key);
  if (lanes.size === 0 && unwatch) {
    unwatch();
    unwatch = null;
  }
}

function schedule(key: string, lane: MixLane): void {
  if (lane.scheduled || lane.inFlight !== undefined) {
    return;
  }
  lane.scheduled = true;
  sendChain = sendChain.then(() => sendLatest(key, lane));
}

async function sendLatest(key: string, lane: MixLane): Promise<void> {
  lane.scheduled = false;
  const value = lane.latest;
  const waiters = lane.waiters;
  lane.latest = undefined;
  lane.waiters = [];
  let result: ExecuteResult = { status: "ok" };
  try {
    if (value === undefined) {
      return;
    }
    if (value === lane.confirmed && !lane.queued) {
      // The burst ended where it began: nothing to save.
      return;
    }
    lane.inFlight = value;
    try {
      const reply = (await lane.send(lane.projectPath, value)) as {
        queued?: boolean;
      } | null;
      if (reply?.queued === true) {
        lane.queued = { value, until: Date.now() + QUEUED_SHOWN_MS };
      } else {
        lane.confirmed = value;
        lane.queued = undefined;
      }
      lane.inFlight = undefined;
    } catch (e) {
      lane.inFlight = undefined;
      const reason = errorMessage(e);
      result = { status: "disabled", reason };
      // Put back the saved value, unless a newer change is on its way or
      // someone else's change has replaced ours.
      const s = useDawStore.getState();
      if (
        lane.latest === undefined &&
        s.projectPath === lane.projectPath &&
        s.project &&
        readField(s.project, lane.trackId, lane.field) === value
      ) {
        overlaying = true;
        try {
          s.setProject(
            patchTrackMix(
              s.project,
              lane.trackId,
              fieldsOf(lane.field, lane.confirmed),
            ),
          );
        } finally {
          overlaying = false;
        }
      }
      s.announceStatus(`Mix change failed: ${reason}`);
    }
  } finally {
    for (const resolve of waiters) {
      resolve(result);
    }
    if (lane.latest !== undefined && lane.timer === undefined) {
      schedule(key, lane);
    }
    // Our own reply replaced `tracks`; show anything newer again.
    overlayPending();
    settle(key, lane);
  }
}

/**
 * Save one mix field: show it at once, then send it. Resolves once this
 * value (or a newer one that replaced it) has been sent.
 */
function commitMixField(
  trackId: string,
  field: MixField,
  value: MixValue,
  send: MixLane["send"],
  delayMs = 0,
): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  const projectPath = s.projectPath;
  const key = `${projectPath}\0${trackId}\0${field}`;
  let lane = lanes.get(key);
  if (!lane) {
    lane = {
      projectPath,
      trackId,
      field,
      send,
      confirmed: readField(s.project, trackId, field) ?? value,
      scheduled: false,
      waiters: [],
    };
    lanes.set(key, lane);
    watchStore();
  }
  const current = lane;
  current.latest = value;
  const done = new Promise<ExecuteResult>((resolve) => {
    current.waiters.push(resolve);
  });
  overlayPending();
  if (current.timer !== undefined) {
    clearTimeout(current.timer);
    current.timer = undefined;
  }
  if (delayMs > 0) {
    current.timer = setTimeout(() => {
      current.timer = undefined;
      schedule(key, current);
    }, delayMs);
  } else {
    schedule(key, current);
  }
  return done;
}

/**
 * Send every waiting mix change now and wait for them, so a following undo,
 * redo or page close doesn't overtake or drop a volume still in its delay.
 */
export async function flushPendingMix(): Promise<void> {
  for (const [key, lane] of lanes) {
    if (lane.timer !== undefined) {
      clearTimeout(lane.timer);
      lane.timer = undefined;
      schedule(key, lane);
    }
  }
  let chain: Promise<void>;
  do {
    chain = sendChain;
    await chain;
  } while (chain !== sendChain);
}

/** Tests only: forget every lane and timer. */
export function _resetMixLanesForTests(): void {
  for (const lane of lanes.values()) {
    if (lane.timer !== undefined) {
      clearTimeout(lane.timer);
    }
  }
  lanes.clear();
  unwatch?.();
  unwatch = null;
  sendChain = Promise.resolve();
}

function hookPageHide(): void {
  if (pageHooked || typeof window === "undefined") {
    return;
  }
  pageHooked = true;
  window.addEventListener("pagehide", () => {
    void flushPendingMix();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flushPendingMix();
    }
  });
}

/**
 * Track mix commands (#386). M is the saved mix mute for the host and editors
 * and a listen-only mute for everyone else; volume is saved and editor-only.
 * Solo (track.soloToggle) stays listen-only for everyone.
 */
export function registerTrackMixCommands(): void {
  hookPageHide();

  registerCommand("track.muteToggle", async (args, ctx) => {
    const trackId = resolveTrackId(args);
    if (!trackId) {
      return { status: "disabled", reason: "No track selected" };
    }
    const s = useDawStore.getState();
    const track = s.project?.tracks.find((t) => t.id === trackId);
    if (!evaluateWhen("canEditMix", ctx).ok) {
      if (track?.muted) {
        s.announceStatus(SAVED_MUTE_READ_ONLY);
        return { status: "disabled", reason: SAVED_MUTE_READ_ONLY };
      }
      s.toggleViewerMute(trackId);
      return { status: "ok" };
    }
    if (!track) {
      return { status: "disabled", reason: "Unknown track" };
    }
    if (s.viewerMute[trackId]) {
      // A listen-only mute left from a session or a followed guest goes
      // first. If that's all the chip showed, M is done.
      s.toggleViewerMute(trackId);
      if (!track.muted) {
        return { status: "ok" };
      }
    }
    return commitMixField(trackId, "muted", !track.muted, (path, value) =>
      setTrackMuteCommand(path, trackId, Boolean(value)),
    );
  });

  registerCommand("track.setVolume", async (args, ctx) => {
    const trackId = resolveTrackId(args);
    if (!trackId) {
      return { status: "disabled", reason: "No track selected" };
    }
    if (typeof args.db !== "number" || !Number.isFinite(args.db)) {
      return { status: "disabled", reason: "Volume must be a number of dB" };
    }
    const gate = evaluateWhen("canEditMix", ctx);
    if (!gate.ok) {
      return { status: "disabled", reason: gate.reason };
    }
    return commitMixField(
      trackId,
      "fader_db",
      clampFaderDb(args.db),
      (path, value) => setTrackFaderCommand(path, trackId, Number(value)),
      VOLUME_SAVE_DELAY_MS,
    );
  });
}
