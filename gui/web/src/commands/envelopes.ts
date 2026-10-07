import { setEnvelope } from "../api";
import { useDawStore } from "../state/dawStore";
import { errorMessage } from "../utils/apiError";
import {
  ENVELOPE_POINT_EPSILON,
  envelopeValueAt,
  findVolumeEnvelope,
} from "../utils/envelopes";
import { randomUuid } from "../utils/randomUuid";
import { clampToSession, formatTime } from "../utils/time";
import { buildCommandContext, evaluateWhen } from "./context";
import { registerCommand } from "./execute";
import type { ExecuteResult } from "./types";

/**
 * `envelope.addPoint`: a volume envelope point on `trackId` at `atTime`, at
 * the level the envelope already has there, so adding it changes nothing you
 * hear until you move it. The touch create menu runs it (#1051); it submits
 * the same `SetEnvelope` the envelope inspector's Add point does. The new
 * point is selected, so the strip offers its time and level nudges.
 */
export function registerEnvelopeCommands(): void {
  registerCommand("envelope.addPoint", async (args): Promise<ExecuteResult> => {
    // Pointer dispatch skips `when`; the permission still holds.
    const allowed = evaluateWhen("canEditEnvelopes", buildCommandContext());
    if (!allowed.ok) return { status: "disabled", reason: allowed.reason };
    const state = useDawStore.getState();
    const { project, projectPath, projectEpoch } = state;
    const trackId = typeof args.trackId === "string" ? args.trackId : null;
    const raw = Number(args.atTime);
    if (!project || !trackId || !Number.isFinite(raw)) {
      return { status: "disabled", reason: "Hold on a track to add a point" };
    }
    if (!project.tracks.some((track) => track.id === trackId)) {
      return { status: "disabled", reason: "That track is gone" };
    }
    const time = clampToSession(raw, project.timeline_duration_sec);
    const origin = (
      findVolumeEnvelope(project.envelopes, trackId)?.points ?? []
    ).map((point) => ({ ...point }));
    if (
      origin.some(
        (point) => Math.abs(point.time - time) <= ENVELOPE_POINT_EPSILON,
      )
    ) {
      return { status: "disabled", reason: "A point is already there" };
    }
    const point = {
      id: randomUuid(),
      time,
      value: envelopeValueAt(origin, time),
    };
    const next = [...origin, point].sort((a, b) => a.time - b.time);
    try {
      await setEnvelope(projectPath, trackId, next, origin);
    } catch (error) {
      const reason = errorMessage(error, "Could not add the point");
      useDawStore.getState().announceStatus(`Point not added: ${reason}`);
      return { status: "disabled", reason };
    }
    const live = useDawStore.getState();
    if (live.projectEpoch !== projectEpoch) return { status: "ok" };
    live.setLayerVisible("showLevels", true);
    live.setSelection({ kind: "envelopePoint", trackId, pointId: point.id });
    live.announceStatus(`Envelope point added at ${formatTime(time)}`);
    return { status: "ok" };
  });
}
