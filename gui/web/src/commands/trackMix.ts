import { setTrackFaderCommand, setTrackMuteCommand } from "../api";
import { patchTrackMix } from "../document/projectPatch";
import { useDawStore } from "../state/dawStore";
import type { TrackView } from "../types/project";
import { errorMessage } from "../utils/apiError";
import { clampFaderDb } from "../utils/audio";
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

type MixField = "fader_db" | "muted";
type MixValue = number | boolean;

/**
 * One saved field of one track. At most one send is in flight; newer values
 * wait and only the latest is sent, so steps land in order and a burst costs
 * one command.
 */
interface MixLane {
  projectPath: string;
  trackId: string;
  field: MixField;
  send: (projectPath: string, value: MixValue) => Promise<unknown>;
  /** The saved value a failure reverts to. */
  confirmed: MixValue;
  latest?: MixValue;
  sending: boolean;
  timer?: ReturnType<typeof setTimeout>;
  waiters: Array<(result: ExecuteResult) => void>;
}

const lanes = new Map<string, MixLane>();

function fieldValue(
  trackId: string,
  field: MixField,
  projectPath: string,
): MixValue | undefined {
  const s = useDawStore.getState();
  if (s.projectPath !== projectPath) {
    return undefined;
  }
  const track = s.project?.tracks.find((t) => t.id === trackId);
  return field === "muted" ? track?.muted : (track?.fader_db ?? 0);
}

/** Show a value on this client (a no-op once the user switched projects). */
function showValue(lane: MixLane, value: MixValue): void {
  const s = useDawStore.getState();
  if (s.projectPath !== lane.projectPath || !s.project) {
    return;
  }
  const fields: Partial<Pick<TrackView, MixField>> =
    lane.field === "muted"
      ? { muted: value as boolean }
      : { fader_db: value as number };
  s.setProject(patchTrackMix(s.project, lane.trackId, fields));
}

async function flush(key: string, lane: MixLane): Promise<void> {
  if (lane.sending || lane.timer !== undefined || lane.latest === undefined) {
    return;
  }
  const value = lane.latest;
  const waiters = lane.waiters;
  lane.latest = undefined;
  lane.waiters = [];
  lane.sending = true;
  let result: ExecuteResult = { status: "ok" };
  try {
    await lane.send(lane.projectPath, value);
    lane.confirmed = value;
  } catch (e) {
    const reason = errorMessage(e);
    result = { status: "disabled", reason };
    // Put back the saved value, unless a newer change is on its way or
    // someone else's change has replaced ours.
    if (
      lane.latest === undefined &&
      fieldValue(lane.trackId, lane.field, lane.projectPath) === value
    ) {
      showValue(lane, lane.confirmed);
    }
    useDawStore.getState().announceStatus(`Mix change failed: ${reason}`);
  }
  lane.sending = false;
  for (const resolve of waiters) {
    resolve(result);
  }
  if (lane.latest !== undefined) {
    // Our own reply just replaced the field; keep showing the newer value.
    showValue(lane, lane.latest);
    await flush(key, lane);
  } else if (lane.timer === undefined && lanes.get(key) === lane) {
    lanes.delete(key);
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
  const projectPath = useDawStore.getState().projectPath;
  const key = `${projectPath}\0${trackId}\0${field}`;
  let lane = lanes.get(key);
  if (!lane) {
    lane = {
      projectPath,
      trackId,
      field,
      send,
      confirmed: fieldValue(trackId, field, projectPath) ?? value,
      sending: false,
      waiters: [],
    };
    lanes.set(key, lane);
  }
  const current = lane;
  current.latest = value;
  showValue(current, value);
  const done = new Promise<ExecuteResult>((resolve) => {
    current.waiters.push(resolve);
  });
  if (current.timer !== undefined) {
    clearTimeout(current.timer);
    current.timer = undefined;
  }
  if (delayMs > 0) {
    current.timer = setTimeout(() => {
      current.timer = undefined;
      void flush(key, current);
    }, delayMs);
  } else {
    void flush(key, current);
  }
  return done;
}

/**
 * Track mix commands (#386). M is the saved mix mute for the host and editors
 * and a listen-only mute for everyone else; volume is saved and editor-only.
 * Solo (track.soloToggle) stays listen-only for everyone.
 */
export function registerTrackMixCommands(): void {
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
      // A listen-only mute left from a session or a followed guest: M clears
      // it first, so the chip always shows what M does next.
      s.toggleViewerMute(trackId);
      return { status: "ok" };
    }
    return commitMixField(trackId, "muted", !track.muted, (path, value) =>
      setTrackMuteCommand(path, trackId, value as boolean),
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
      (path, value) => setTrackFaderCommand(path, trackId, value as number),
      VOLUME_SAVE_DELAY_MS,
    );
  });
}
