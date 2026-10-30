import { setEnvelope } from "../api";
import { useDawStore } from "../state/dawStore";
import type { AutomationPoint, HistoryEntryId } from "../types/project";
import { BUSY_REASON } from "../ui/disabledReason";
import { ApiError, errorMessage } from "../utils/apiError";
import {
  addVolumePoint,
  ENVELOPE_POINT_EPSILON,
  ENVELOPE_VALUE_MAX,
  envelopeTimeRangeMessage,
  envelopeValueAt,
  findVolumeEnvelope,
  replaceEnvelopePoint,
  sameEnvelopePoint,
} from "../utils/envelopes";
import { randomUuid } from "../utils/randomUuid";
import { clampToSession, formatTime } from "../utils/time";
import { buildCommandContext, evaluateWhen } from "./context";
import { registerCommand } from "./execute";
import type { ExecuteResult } from "./types";

/**
 * `envelope.addPoint`: a volume envelope point on `trackId` at `atTime`, at
 * the level the envelope already has there, so adding it changes nothing you
 * hear until you move it. The create menu runs it (#1051). The new point is
 * selected, so the Inspector offers its time and level.
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
    if (!state.layers.showLevels) {
      return {
        status: "disabled",
        reason: "Show the volume envelope before adding a point",
      };
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
    const next = addVolumePoint(origin, point, project.timeline_duration_sec, {
      start: randomUuid(),
      end: randomUuid(),
    });
    let undo: HistoryEntryId | null;
    try {
      undo = await setEnvelope(projectPath, trackId, next, origin);
    } catch (error) {
      const reason = errorMessage(error, "Could not add the point");
      useDawStore
        .getState()
        .announceStatus(`Point not added: ${reason}`, { tone: "error" });
      return { status: "disabled", reason };
    }
    const live = useDawStore.getState();
    if (live.projectEpoch !== projectEpoch) return { status: "ok" };
    live.setSelection({ kind: "envelopePoint", trackId, pointId: point.id });
    live.announceStatus(`Envelope point added at ${formatTime(time)}`, {
      undo,
    });
    return { status: "ok" };
  });
}

export type EnvelopeWrite =
  | { status: "ok" }
  | {
      status: "disabled";
      reason: string;
      /** The host moved the envelope on: the store already holds its points. */
      conflict?: boolean;
      /** The point already at the time asked for. */
      collisionId?: string;
    };

const saving = new Set<string>();

const pointsOf = (trackId: string): AutomationPoint[] =>
  (
    findVolumeEnvelope(useDawStore.getState().project?.envelopes, trackId)
      ?.points ?? []
  ).map((point) => ({ ...point }));

/**
 * One undo step for one change to a point: the sheet's Time and Level and the
 * Delete key share it, and so does the one-save-at-a-time guard, since the
 * host compares the points a save started from.
 */
async function saveEnvelope(
  trackId: string,
  plan: (origin: AutomationPoint[]) => AutomationPoint[] | EnvelopeWrite,
  failed: string,
  settle: (undo: HistoryEntryId | null) => void,
): Promise<EnvelopeWrite> {
  const allowed = evaluateWhen("canEditEnvelopes", buildCommandContext());
  if (!allowed.ok) return { status: "disabled", reason: allowed.reason };
  const state = useDawStore.getState();
  if (!state.layers.showLevels) {
    return {
      status: "disabled",
      reason: "Show the volume envelope before changing points",
    };
  }
  const key = `${state.projectPath}:${state.projectEpoch}:${trackId}`;
  if (saving.has(key)) return { status: "disabled", reason: BUSY_REASON };
  const origin = pointsOf(trackId);
  const next = plan(origin);
  if (!Array.isArray(next)) return next;
  saving.add(key);
  try {
    const undo = await setEnvelope(state.projectPath, trackId, next, origin);
    if (useDawStore.getState().projectEpoch === state.projectEpoch)
      settle(undo);
    return { status: "ok" };
  } catch (error) {
    return {
      status: "disabled",
      reason: errorMessage(error, failed),
      conflict: error instanceof ApiError && error.status === 409,
    };
  } finally {
    saving.delete(key);
  }
}

export function setEnvelopePoint(
  trackId: string,
  pointId: string,
  edit: { time?: number; value?: number },
): Promise<EnvelopeWrite> {
  return saveEnvelope(
    trackId,
    (origin) => {
      const was = origin.find((point) => point.id === pointId);
      if (!was) return { status: "disabled", reason: "That point is gone" };
      const time = edit.time ?? was.time;
      const value = edit.value ?? was.value;
      if (!Number.isFinite(time) || time < 0)
        return {
          status: "disabled",
          reason: "Time must be a finite, non-negative number.",
        };
      if (!Number.isFinite(value) || value < 0 || value > ENVELOPE_VALUE_MAX)
        return {
          status: "disabled",
          reason: "Level must be a number from 0 to 1.50.",
        };
      const duration =
        useDawStore.getState().project?.timeline_duration_sec ?? 0;
      if (time > duration && was.time !== time)
        return {
          status: "disabled",
          reason: envelopeTimeRangeMessage(duration),
        };
      const collision = origin.find(
        (point) =>
          point.id !== pointId &&
          Math.abs(point.time - time) <= ENVELOPE_POINT_EPSILON,
      );
      if (collision)
        return {
          status: "disabled",
          reason:
            "A point already exists at this time. Choose a different time or select that point.",
          collisionId: collision.id,
        };
      const moved = { id: pointId, time, value };
      return sameEnvelopePoint(was, moved)
        ? { status: "ok" }
        : replaceEnvelopePoint(origin, moved);
    },
    "Could not save the volume envelope",
    (undo) =>
      useDawStore.getState().announceStatus("Envelope point changed", { undo }),
  );
}

export function removeEnvelopePoint(
  trackId: string,
  pointId: string,
): Promise<EnvelopeWrite> {
  return saveEnvelope(
    trackId,
    (origin) =>
      origin.some((point) => point.id === pointId)
        ? origin.filter((point) => point.id !== pointId)
        : { status: "disabled", reason: "That point is gone" },
    "Could not remove the point",
    (undo) => {
      const live = useDawStore.getState();
      live.setSelection({ kind: "envelope", trackId });
      live.announceStatus("Envelope point removed", { undo });
    },
  );
}
