import {
  clearExtractedRoomToneBedCommand,
  extractRoomToneBedCommand,
} from "../api";
import { canManageProjects } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { errorMessage } from "../utils/apiError";
import { registerCommand } from "./execute";
import { createSingleFlight } from "./singleFlight";
import type { ExecuteResult } from "./types";

const REASONS: Record<string, string> = {
  has_bed: "already has a room tone that was recorded or assigned",
  recorded_bed: "has a room tone that was recorded or assigned, so it stays",
  already_extracted: "already has a room tone cut from this audio",
  no_bed: "has no cut room tone to remove",
  missing_media: "has no audio yet",
  voice_detector_missing:
    "cannot be checked for speech until the voice detector is installed",
  digital_silence: "is digital silence, so there is no room tone to cut",
  no_quiet_run: "has no stretch quiet enough to use",
  too_short: "has no quiet stretch long enough to use",
  rejected: "has a quiet stretch, but it sounds like more than room tone",
};

export function roomToneBedReason(label: string, reason: string): string {
  const why = REASONS[reason] ?? "could not be changed";
  return `${label} ${why}`;
}

export function roomToneBedBlocker(
  track: { media_path?: string | null } | undefined,
  host: boolean,
): string | null {
  if (!host) return "Only the host can change room tone";
  if (!track) return "Select a track";
  if (!track.media_path) return "Import audio first";
  return null;
}

const flight = createSingleFlight();

function target(args: Record<string, unknown>) {
  const s = useDawStore.getState();
  const trackId =
    typeof args.trackId === "string" && args.trackId
      ? args.trackId
      : s.selection?.kind === "track"
        ? s.selection.trackId
        : null;
  const track = s.project?.tracks.find((t) => t.id === trackId);
  return { s, track };
}

async function change(
  args: Record<string, unknown>,
  verb: {
    busy: string;
    done: string;
    fail: string;
    wanted: "extract" | "clear";
  },
): Promise<ExecuteResult> {
  const { s, track } = target(args);
  const blocker = roomToneBedBlocker(track, canManageProjects(s.projectPath));
  if (blocker || !track) return { status: "disabled", reason: blocker! };
  const label = track.label || track.id;
  const projectPath = s.projectPath;
  const run = await flight.run(async (): Promise<ExecuteResult> => {
    s.announceStatus(verb.busy.replace("{label}", label));
    try {
      const outcome =
        verb.wanted === "extract"
          ? await extractRoomToneBedCommand(projectPath, track.id)
          : await clearExtractedRoomToneBedCommand(projectPath, track.id);
      const live = useDawStore.getState();
      if (outcome.done) {
        live.announceStatus(verb.done.replace("{label}", label), {
          undo: outcome.historyHead,
        });
        return { status: "ok" };
      }
      const reason = roomToneBedReason(label, outcome.reason);
      live.announceStatus(reason);
      return { status: "disabled", reason, told: true };
    } catch (e) {
      const msg = errorMessage(e);
      useDawStore
        .getState()
        .announceStatus(`${verb.fail.replace("{label}", label)}: ${msg}`, {
          tone: "error",
        });
      return { status: "disabled", reason: msg, told: true };
    }
  }, "room-tone");
  return run.ran
    ? run.value
    : { status: "disabled", reason: "Room tone is already changing" };
}

/** Extract and Remove room tone on a track; each is one undo step on the host. */
export function registerRoomToneBedCommands(): void {
  registerCommand("track.extractRoomTone", (args) =>
    change(args, {
      wanted: "extract",
      busy: "Cutting room tone from {label}…",
      done: "Cut room tone from {label}",
      fail: "Room tone failed",
    }),
  );
  registerCommand("track.clearRoomTone", (args) =>
    change(args, {
      wanted: "clear",
      busy: "Removing room tone from {label}…",
      done: "Removed room tone from {label}",
      fail: "Remove room tone failed",
    }),
  );
}
