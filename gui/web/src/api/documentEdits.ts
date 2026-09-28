import { hostFetch } from "../api/documentTransport";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { submitQueuedDocumentCommand } from "../services/commandQueue";
import { shareTokenFromKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import {
  type OfflineConflict,
  removeConflictsWhere,
  removeHostConflictsWhere,
} from "../state/offlineStore";
import type { AutomationPoint } from "../types/project";
import { ApiError, readApiError } from "../utils/apiError";
import { withVolumeEnvelopePoints } from "../utils/envelopes";
import { loadProjectPhase } from "./project";

/** Wire shape for a guarded transcript command's optional stale-text guard. */
function withExpectedText(expectedText?: string | null): {
  expected_text?: string;
} {
  return expectedText == null ? {} : { expected_text: expectedText };
}

export async function submitDocumentCommand(
  projectPath: string,
  type: string,
  payload: Record<string, unknown> = {},
  opts?: {
    command_id?: string;
    client_seq?: number;
    structural_mode?: "propose" | "apply";
    offline?: boolean;
    replaying?: boolean;
    client_id?: string;
  },
): Promise<Record<string, unknown>> {
  return submitQueuedDocumentCommand(projectPath, type, payload, opts);
}

export async function undoHistory(
  projectPath: string,
  opts?: { rerender?: boolean },
): Promise<void> {
  await submitDocumentCommand(projectPath, "UndoHistory", {
    rerender: opts?.rerender ?? false,
  });
}

export async function redoHistory(
  projectPath: string,
  opts?: { rerender?: boolean },
): Promise<void> {
  await submitDocumentCommand(projectPath, "RedoHistory", {
    rerender: opts?.rerender ?? false,
  });
}

/** `queued`: saved and sent later by the drain, so the outcome is not known yet. */
export async function approveEdits(
  projectPath: string,
  ids: string[],
): Promise<{ queued: boolean }> {
  const result = await submitDocumentCommand(projectPath, "ApproveEdits", {
    ids,
  });
  return { queued: result.queued === true };
}

export async function waiveTranscriptRefine(
  projectPath: string,
  reason: string,
): Promise<void> {
  const res = await hostFetch("/api/transcript/refine/waive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath, reason }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
}

/** `queued`: saved and sent later by the drain, so the outcome is not known yet. */
export async function rejectEdits(
  projectPath: string,
  ids: string[],
): Promise<{ queued: boolean }> {
  const result = await submitDocumentCommand(projectPath, "RejectEdits", {
    ids,
  });
  return { queued: result.queued === true };
}

export async function updatePendingEdit(
  projectPath: string,
  id: string,
  start: number,
  end: number,
  snap = true,
  trackIds?: string[] | null,
): Promise<void> {
  await submitDocumentCommand(projectPath, "UpdatePendingEdit", {
    id,
    start,
    end,
    snap,
    ...(trackIds != null ? { track_ids: trackIds } : {}),
  });
}

export async function restoreAppliedEdit(
  projectPath: string,
  id: string,
): Promise<void> {
  await submitDocumentCommand(projectPath, "RestoreAppliedEdit", { id });
}

export async function setClipFade(
  projectPath: string,
  clipId: string,
  fadeInMs: number,
  fadeOutMs: number,
): Promise<void> {
  await submitDocumentCommand(projectPath, "SetClipFade", {
    clip_id: clipId,
    fade_in_ms: fadeInMs,
    fade_out_ms: fadeOutMs,
  });
}

export async function trimClipEdge(
  projectPath: string,
  clipId: string,
  edge: "in" | "out",
  sourceSec: number,
  mode: "ripple" = "ripple",
): Promise<void> {
  await submitDocumentCommand(projectPath, "TrimClipEdge", {
    clip_id: clipId,
    edge,
    source_sec: sourceSec,
    mode,
  });
}

export async function rollClipJoin(
  projectPath: string,
  leftClipId: string,
  rightClipId: string,
  deltaSec: number,
): Promise<void> {
  await submitDocumentCommand(projectPath, "RollClipJoin", {
    left_clip_id: leftClipId,
    right_clip_id: rightClipId,
    delta_sec: deltaSec,
  });
}

export async function moveClips(
  projectPath: string,
  clips: Array<{
    clip_id: string;
    timeline_start: number;
    track_id: string;
  }>,
): Promise<void> {
  await submitDocumentCommand(projectPath, "MoveClips", { clips });
}

/** Set a join's mode and both edge fades in one undo step. */
export async function setClipJoin(
  projectPath: string,
  leftClipId: string,
  rightClipId: string,
  mode: string,
  lengthMs?: number | null,
): Promise<void> {
  await submitDocumentCommand(projectPath, "SetClipJoin", {
    left_clip_id: leftClipId,
    right_clip_id: rightClipId,
    mode,
    ...(lengthMs == null ? {} : { length_ms: lengthMs }),
  });
}

export async function applyFadeRecommendations(
  projectPath: string,
  trackId?: string | null,
): Promise<void> {
  await submitDocumentCommand(projectPath, "ApplyFadeRecommendations", {
    track_id: trackId ?? null,
  });
}

export async function setEffectBypass(
  projectPath: string,
  trackId: string,
  effectIndex: number,
  bypass: boolean,
): Promise<void> {
  await submitDocumentCommand(projectPath, "SetEffectBypass", {
    track_id: trackId,
    effect_index: effectIndex,
    bypass,
  });
}

/**
 * Send a transcript correction. On a 409 (the words changed since the caller
 * captured `expected_text`), load the host's current transcript words (the
 * `detail` phase) into the store before rethrowing, as `setEnvelope` does for
 * envelopes. The Correct inspector then re-captures its baseline from them,
 * so Apply again retries against the current text (#746). Once a correction
 * lands (not queued), earlier refused corrections of the same word leave
 * Needs attention.
 */
async function submitTranscriptCorrection(
  projectPath: string,
  type: "CorrectTranscriptWord" | "CorrectTranscriptPhrase",
  payload: Record<string, unknown>,
): Promise<void> {
  let result: Record<string, unknown>;
  try {
    result = await submitDocumentCommand(projectPath, type, payload);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      await refreshProjectPhase(projectPath, "detail").catch(() => undefined);
    }
    throw error;
  }
  if (result.queued !== true) {
    await clearSupersededCorrectionConflicts(projectPath, payload);
  }
}

/** First word index a transcript correction payload rewrites. */
function correctionStart(payload: Record<string, unknown>): unknown {
  return payload.word_index ?? payload.start_word_index;
}

/**
 * After a transcript correction lands, drop Needs attention entries for
 * earlier refused corrections of the same word (same track and start
 * index), so the banner stops asking the user to redo a correction that
 * has now been made (#746). A failed cleanup never fails the correction;
 * Dismiss all still clears it.
 */
async function clearSupersededCorrectionConflicts(
  projectPath: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const superseded = ({ command }: OfflineConflict) =>
    (command.type === "CorrectTranscriptWord" ||
      command.type === "CorrectTranscriptPhrase") &&
    command.payload.track_id === payload.track_id &&
    correctionStart(command.payload) === correctionStart(payload);
  const token = shareTokenFromKey(projectPath);
  try {
    await (token
      ? removeConflictsWhere(token, superseded)
      : removeHostConflictsWhere(projectPath, superseded));
  } catch {
    // Leave the entry; Dismiss all clears it.
  }
}

export async function correctTranscriptWord(
  projectPath: string,
  trackId: string,
  wordIndex: number,
  text: string,
  expectedText?: string | null,
): Promise<void> {
  await submitTranscriptCorrection(projectPath, "CorrectTranscriptWord", {
    track_id: trackId,
    word_index: wordIndex,
    text,
    ...withExpectedText(expectedText),
  });
}

export async function correctTranscriptPhrase(
  projectPath: string,
  trackId: string,
  startWordIndex: number,
  endWordIndex: number,
  text: string,
  expectedText?: string | null,
): Promise<void> {
  await submitTranscriptCorrection(projectPath, "CorrectTranscriptPhrase", {
    track_id: trackId,
    start_word_index: startWordIndex,
    end_word_index: endWordIndex,
    text,
    ...withExpectedText(expectedText),
  });
}

export async function setTranscriptWordSuppressed(
  projectPath: string,
  trackId: string,
  wordIndex: number,
  suppressed: boolean,
  expectedText?: string | null,
): Promise<void> {
  await submitDocumentCommand(projectPath, "SetTranscriptWordSuppressed", {
    track_id: trackId,
    word_index: wordIndex,
    suppressed,
    ...withExpectedText(expectedText),
  });
}

export async function setTranscriptWordsIgnored(
  projectPath: string,
  trackId: string,
  startWordIndex: number,
  endWordIndex: number,
  ignored: boolean,
  expectedText?: string | null,
): Promise<void> {
  await submitDocumentCommand(projectPath, "SetTranscriptWordsIgnored", {
    track_id: trackId,
    start_word_index: startWordIndex,
    end_word_index: endWordIndex,
    ignored,
    ...withExpectedText(expectedText),
  });
}

export async function setEnvelope(
  projectPath: string,
  trackId: string,
  points: AutomationPoint[],
  expectedPoints: AutomationPoint[],
): Promise<void> {
  let result: Record<string, unknown>;
  try {
    result = await submitDocumentCommand(projectPath, "SetEnvelope", {
      track_id: trackId,
      points,
      // Echo the store's points verbatim: the host compares floats exactly.
      expected_points: expectedPoints,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      // Load the host's current points so redoing the edit uses a fresh baseline.
      await refreshProjectPhase(projectPath, "envelopes").catch(
        () => undefined,
      );
    }
    throw error;
  }
  if (result.queued === true) {
    // Show the queued edit, and make it the next edit's baseline: replay
    // applies queued commands in order, so the host will hold these points.
    applyQueuedEnvelope(projectPath, trackId, points);
  }
}

/** Load one projection phase from the host and force it into the store, so the next edit's baseline is the host's current state (used after a 409). */
async function refreshProjectPhase(
  projectPath: string,
  phase: "envelopes" | "detail",
): Promise<void> {
  const patch = await loadProjectPhase(projectPath, phase);
  if (useDawStore.getState().projectPath === projectPath) {
    applyDocumentSnapshot({ patch }, { force: true });
  }
}

function applyQueuedEnvelope(
  projectPath: string,
  trackId: string,
  points: AutomationPoint[],
): void {
  useDawStore.setState((state) =>
    state.projectPath === projectPath && state.project
      ? {
          project: {
            ...state.project,
            envelopes: withVolumeEnvelopePoints(
              state.project.envelopes,
              trackId,
              points,
            ),
          },
        }
      : state,
  );
}

export async function addChapter(
  projectPath: string,
  time: number,
  title: string,
): Promise<void> {
  await submitDocumentCommand(projectPath, "AddChapter", { time, title });
}

export async function updateChapter(
  projectPath: string,
  oldTime: number,
  oldTitle: string,
  time: number,
  title: string,
): Promise<void> {
  await submitDocumentCommand(projectPath, "UpdateChapter", {
    old_time: oldTime,
    old_title: oldTitle,
    time,
    title,
  });
}

export async function deleteChapter(
  projectPath: string,
  time: number,
  title: string,
): Promise<void> {
  await submitDocumentCommand(projectPath, "DeleteChapter", { time, title });
}

export async function addSocialClip(
  projectPath: string,
  trackId: string,
  start: number,
  end: number,
  title?: string | null,
): Promise<void> {
  await submitDocumentCommand(projectPath, "AddSocialClip", {
    track_id: trackId,
    start,
    end,
    title: title ?? null,
  });
}

export async function updateSocialClip(
  projectPath: string,
  id: string,
  start: number,
  end: number,
): Promise<void> {
  await submitDocumentCommand(projectPath, "UpdateSocialClip", {
    id,
    start,
    end,
  });
}

export async function deleteSocialClip(
  projectPath: string,
  id: string,
): Promise<void> {
  await submitDocumentCommand(projectPath, "DeleteSocialClip", { id });
}

export async function suggestPendingEdit(
  projectPath: string,
  trackId: string,
  start: number,
  end: number,
  reason?: string | null,
): Promise<void> {
  await submitDocumentCommand(projectPath, "SuggestPendingEdit", {
    track_id: trackId,
    start,
    end,
    reason: reason ?? null,
  });
}

export async function splitAtTime(
  projectPath: string,
  atTime: number,
  trackIds?: string[] | null,
  reason?: string | null,
): Promise<void> {
  await submitDocumentCommand(projectPath, "SplitAtTime", {
    at_time: atTime,
    track_ids: trackIds ?? null,
    reason: reason ?? null,
  });
}

export async function deleteClips(
  projectPath: string,
  clipIds: string[],
): Promise<void> {
  await submitDocumentCommand(projectPath, "DeleteClip", {
    clip_ids: clipIds,
  });
}

export async function rippleDeleteClips(
  projectPath: string,
  clipIds: string[],
): Promise<void> {
  await submitDocumentCommand(projectPath, "RippleDeleteClip", {
    clip_ids: clipIds,
  });
}

export async function duplicateSegment(
  projectPath: string,
  sourceStart: number,
  sourceEnd: number,
  insertAt: number,
): Promise<void> {
  await submitDocumentCommand(projectPath, "DuplicateSegment", {
    source_start: sourceStart,
    source_end: sourceEnd,
    insert_at: insertAt,
  });
}

export async function moveSegment(
  projectPath: string,
  sourceStart: number,
  sourceEnd: number,
  insertAt: number,
): Promise<void> {
  await submitDocumentCommand(projectPath, "MoveSegment", {
    source_start: sourceStart,
    source_end: sourceEnd,
    insert_at: insertAt,
  });
}

export async function pasteSegment(
  projectPath: string,
  insertAt: number,
  duration: number,
  extracts: Array<Record<string, unknown>>,
): Promise<void> {
  await submitDocumentCommand(projectPath, "PasteSegment", {
    insert_at: insertAt,
    duration,
    extracts,
  });
}

export async function rippleDeleteRange(
  projectPath: string,
  start: number,
  end: number,
): Promise<void> {
  await submitDocumentCommand(projectPath, "RippleDeleteRange", {
    start,
    end,
  });
}

/** Reload project view after a document-plane mutation. */
export async function addTrackCommand(
  projectPath: string,
  opts?: {
    track_id?: string;
    label?: string;
    role?: string;
    speaker?: string;
  },
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, "AddTrack", { ...(opts ?? {}) });
}

export async function setTrackMediaCommand(
  projectPath: string,
  trackId: string,
  relPath: string,
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, "SetTrackMedia", {
    track_id: trackId,
    rel_path: relPath,
  });
}

export async function setTrackMetaCommand(
  projectPath: string,
  trackId: string,
  opts: { label?: string; role?: string; speaker?: string },
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, "SetTrackMeta", {
    track_id: trackId,
    ...opts,
  });
}

export async function setTrackFaderCommand(
  projectPath: string,
  trackId: string,
  faderDb: number,
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, "SetTrackFader", {
    track_id: trackId,
    fader_db: faderDb,
  });
}

export async function setTrackMuteCommand(
  projectPath: string,
  trackId: string,
  muted: boolean,
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, "SetTrackMute", {
    track_id: trackId,
    muted,
  });
}

export async function removeTrackCommand(
  projectPath: string,
  trackId: string,
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, "RemoveTrack", {
    track_id: trackId,
  });
}

export async function reorderTrackCommand(
  projectPath: string,
  trackId: string,
  index: number,
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, "ReorderTrack", {
    track_id: trackId,
    index,
  });
}
