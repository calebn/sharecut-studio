import { hostFetch } from "../api/documentTransport";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import {
  activateDocumentScope,
  isCurrentDocumentScope,
} from "../document/authorityState";
import type { EditMode, TrimEdge } from "../edit/clipEdgePreview";
import {
  type CutSpeechChoices,
  cutSpeechOf,
  type RippleOutcome,
} from "../edit/cutSpeech";
import {
  type DocumentCommandOptions,
  submitQueuedDocumentCommand,
} from "../services/commandQueue";
import {
  isShareProjectKey,
  reviewApiBase,
  shareTokenFromKey,
} from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { trackEditSave } from "../state/hostSendOrder";
import {
  type OfflineConflict,
  removeConflictsWhere,
  removeHostConflictsWhere,
} from "../state/offlineStore";
import {
  type AutomationPoint,
  type HistoryEntryId,
  type PendingEditView,
  parseHistoryEntryId,
} from "../types/project";
import { ApiError, readApiError } from "../utils/apiError";
import { withVolumeEnvelopePoints } from "../utils/envelopes";
import { loadBoundaryContext } from "./boundary";
import { loadDocumentState } from "./project";

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
  opts?: DocumentCommandOptions,
): Promise<Record<string, unknown>> {
  return submitQueuedDocumentCommand(projectPath, type, payload, opts);
}

/** The server refused an undo or redo because history moved past `expectedHeadId`. */
export const HISTORY_STALE_CODE = "history_stale";

export type HistoryMoveOptions = {
  rerender?: boolean;
  /**
   * The head the caller saw (`history.head_id`, `root` before any entry).
   * Required: the server refuses (`history_stale`) once it is not the head.
   */
  expectedHeadId: HistoryEntryId;
};

async function moveHistoryHead(
  type: "UndoHistory" | "RedoHistory",
  projectPath: string,
  opts: HistoryMoveOptions,
): Promise<HistoryEntryId | null> {
  const result = await submitDocumentCommand(projectPath, type, {
    rerender: opts.rerender ?? false,
    expected_head_id: opts.expectedHeadId,
  });
  return replyHistoryHead(result);
}

/** Undo; resolves with the head the move left (null when queued offline or a retry). */
export function undoHistory(
  projectPath: string,
  opts: HistoryMoveOptions,
): Promise<HistoryEntryId | null> {
  return moveHistoryHead("UndoHistory", projectPath, opts);
}

/** Redo; resolves with the head the move left (null when queued offline or a retry). */
export function redoHistory(
  projectPath: string,
  opts: HistoryMoveOptions,
): Promise<HistoryEntryId | null> {
  return moveHistoryHead("RedoHistory", projectPath, opts);
}

/**
 * A rippling command's outcome. When the host refused it because it would cut
 * other speech, nothing changed: open the cut-speech prompt with `choices` and
 * report `asked`.
 */
function rippleOutcome(
  projectPath: string,
  result: Record<string, unknown>,
  choices: CutSpeechChoices,
): RippleOutcome {
  const speech = cutSpeechOf(result);
  if (speech)
    useDawStore
      .getState()
      .setCutSpeechPrompt({ projectPath, speech, ...choices });
  return { queued: result.queued === true, asked: speech !== null };
}

/** Commands whose gap form is the same payload in `mode: gap` (a trim's needs a new token). */
const GAP_BY_MODE = new Set(["DeleteClip", "CutRange"]);

/** A queued ripple the host held back when the drain replayed it asks now, as a live send does. */
export function askIfReplayHeldBack(
  projectPath: string,
  type: string,
  payload: Record<string, unknown>,
  result: Record<string, unknown>,
): void {
  rippleOutcome(projectPath, result, {
    cutAnyway: () =>
      submitDocumentCommand(projectPath, type, {
        ...payload,
        confirm_cut_speech: true,
      }),
    leaveGap: GAP_BY_MODE.has(type)
      ? () =>
          submitDocumentCommand(projectPath, type, { ...payload, mode: "gap" })
      : null,
  });
}

function confirmed(confirmCutSpeech: boolean): { confirm_cut_speech?: true } {
  return confirmCutSpeech ? { confirm_cut_speech: true } : {};
}

/**
 * The history entry a command's own reply says it left at the head, read under
 * the server's lock with the change. Null when the command moved no history, or
 * was queued, so a toast never offers to undo someone else's change.
 */
export function replyHistoryHead(
  result: Record<string, unknown>,
): HistoryEntryId | null {
  return parseHistoryEntryId(result.history_head_id);
}

/** `queued`: saved and sent later by the drain, so the outcome is not known yet. */
export async function approveEdits(
  projectPath: string,
  ids: string[],
  confirmCutSpeech = false,
): Promise<RippleOutcome & { historyHead: HistoryEntryId | null }> {
  const result = await submitDocumentCommand(projectPath, "ApproveEdits", {
    ids,
    ...confirmed(confirmCutSpeech),
  });
  return {
    ...rippleOutcome(projectPath, result, {
      cutAnyway: () => approveEdits(projectPath, ids, true),
      leaveGap: null,
    }),
    historyHead: replyHistoryHead(result),
  };
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
): Promise<{ queued: boolean; historyHead: HistoryEntryId | null }> {
  const result = await submitDocumentCommand(projectPath, "RejectEdits", {
    ids,
  });
  return {
    queued: result.queued === true,
    historyHead: replyHistoryHead(result),
  };
}

export type SourceRange = Readonly<{ start: number; end: number }>;

export type PendingEditBaseline = Readonly<
  Pick<PendingEditView, "track_id" | "type"> &
    SourceRange & { timebase: string }
>;

export function pendingEditBaseline(
  edit: Pick<
    PendingEditView,
    "track_id" | "type" | "timebase" | "source_start" | "source_end"
  >,
): PendingEditBaseline {
  if (edit.source_start == null || edit.source_end == null) {
    throw new Error("This proposal has no editable source bounds.");
  }
  return {
    track_id: edit.track_id,
    type: edit.type,
    timebase: edit.timebase ?? "source",
    start: edit.source_start,
    end: edit.source_end,
  };
}

export type PendingCutProposal = Readonly<{
  editId: PendingEditView["id"];
  trackId: PendingEditView["track_id"];
  original: SourceRange;
  expected: PendingEditBaseline;
  suggested: SourceRange;
  mode: string;
  confidence: number;
  startShiftMs: number;
  endShiftMs: number;
  durationDeltaMs: number;
}>;

function isSuggestionRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function suggestionNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Invalid cut suggestion response");
  }
  return value;
}

function suggestionRange(start: unknown, end: unknown): SourceRange {
  const range = { start: suggestionNumber(start), end: suggestionNumber(end) };
  if (range.start < 0 || range.end <= range.start) {
    throw new Error("Invalid cut suggestion bounds");
  }
  return range;
}

type PendingCutIdentity = Pick<
  PendingEditView,
  "id" | "track_id" | "type" | "timebase" | "source_start" | "source_end"
>;

function parsePendingCutSuggestion(
  value: unknown,
  edit: PendingCutIdentity,
): PendingCutProposal {
  if (!isSuggestionRecord(value) || !isSuggestionRecord(value.optimized)) {
    throw new Error("Invalid cut suggestion response");
  }
  if (value.edit_id !== edit.id || value.track_id !== edit.track_id) {
    throw new Error("Cut suggestion belongs to another edit");
  }
  const original = suggestionRange(value.original_start, value.original_end);
  if (
    original.start !== edit.source_start ||
    original.end !== edit.source_end
  ) {
    throw new Error("Cut suggestion is out of date. Reload the current edit.");
  }
  const optimized = value.optimized;
  const suggested = suggestionRange(optimized.start, optimized.end);
  const confidence = suggestionNumber(optimized.confidence);
  if (
    typeof optimized.mode !== "string" ||
    !optimized.mode ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new Error("Invalid cut suggestion response");
  }
  return {
    editId: edit.id,
    trackId: edit.track_id,
    original,
    expected: { ...pendingEditBaseline(edit), ...original },
    suggested,
    mode: optimized.mode,
    confidence,
    startShiftMs: suggestionNumber(optimized.shifted_start_ms),
    endShiftMs: suggestionNumber(optimized.shifted_end_ms),
    durationDeltaMs:
      (suggested.end - suggested.start - (original.end - original.start)) *
      1000,
  };
}

export async function loadPendingCutSuggestion(
  request: { projectPath: string; edit: PendingCutIdentity },
  signal: AbortSignal,
): Promise<PendingCutProposal> {
  const { projectPath, edit } = request;
  const guestToken = shareTokenFromKey(projectPath);
  if (isShareProjectKey(projectPath) && !guestToken) {
    throw new Error("Invalid guest cut suggestion project key");
  }
  const endpoint = `/pending-edits/${encodeURIComponent(edit.id)}/cut-suggestion`;
  const url = guestToken
    ? `${reviewApiBase(guestToken)}/daw${endpoint}`
    : `/api${endpoint}?${new URLSearchParams({ path: projectPath })}`;
  const response = await (guestToken ? fetch : hostFetch)(url, { signal });
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
  const value: unknown = await response.json();
  return parsePendingCutSuggestion(value, edit);
}

export async function updatePendingEdit(
  projectPath: string,
  id: string,
  start: number,
  end: number,
  snap = true,
  trackIds?: string[] | null,
  expected?: PendingEditBaseline,
): Promise<{ queued: false } | { queued: true; commandId: string }> {
  const result = await submitDocumentCommand(projectPath, "UpdatePendingEdit", {
    id,
    start,
    end,
    snap,
    ...(trackIds != null ? { track_ids: trackIds } : {}),
    ...(expected ? { expected } : {}),
  });
  if (result.queued !== true) return { queued: false };
  if (typeof result.command_id !== "string" || !result.command_id) {
    throw new Error("Queued timing command is missing its identity");
  }
  return { queued: true, commandId: result.command_id };
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
  edge: TrimEdge,
  sourceSec: number,
  mode: EditMode,
  expectedToken: string,
  confirmCutSpeech = false,
): Promise<RippleOutcome> {
  const result = await submitDocumentCommand(projectPath, "TrimClipEdge", {
    clip_id: clipId,
    edge,
    source_sec: sourceSec,
    mode,
    expected_token: expectedToken,
    ...confirmed(confirmCutSpeech),
  });
  return rippleOutcome(projectPath, result, {
    cutAnyway: () =>
      trimClipEdge(
        projectPath,
        clipId,
        edge,
        sourceSec,
        mode,
        expectedToken,
        true,
      ),
    leaveGap: () =>
      trimClipEdgeLeavingGap(projectPath, clipId, edge, sourceSec),
  });
}

/** A gap trim has its own limits, so it needs a token minted for gap mode. */
function trimClipEdgeLeavingGap(
  projectPath: string,
  clipId: string,
  edge: TrimEdge,
  sourceSec: number,
): Promise<RippleOutcome> {
  return trackEditSave(
    projectPath,
    sendTrimClipEdgeLeavingGap(projectPath, clipId, edge, sourceSec),
  );
}

async function sendTrimClipEdgeLeavingGap(
  projectPath: string,
  clipId: string,
  edge: TrimEdge,
  sourceSec: number,
): Promise<RippleOutcome> {
  const clips = useDawStore.getState().project?.clips.tracks ?? {};
  const clip = Object.values(clips)
    .flat()
    .find((c) => c.id === clipId);
  if (!clip) throw new Error("This clip changed. Trim it again.");
  const { id, source_start, source_end, timeline_start, source_id } = clip;
  const boundary = await loadBoundaryContext(
    projectPath,
    { kind: "trim", clip_id: clipId, edge, mode: "gap" },
    [{ id, source_start, source_end, timeline_start, source_id }],
  );
  return trimClipEdge(
    projectPath,
    clipId,
    edge,
    sourceSec,
    "gap",
    boundary.token,
  );
}

export async function rollClipJoin(
  projectPath: string,
  leftClipId: string,
  rightClipId: string,
  deltaSec: number,
  expectedToken: string,
): Promise<{ queued: boolean }> {
  const result = await submitDocumentCommand(projectPath, "RollClipJoin", {
    left_clip_id: leftClipId,
    right_clip_id: rightClipId,
    delta_sec: deltaSec,
    expected_token: expectedToken,
  });
  return { queued: result.queued === true };
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
    await clearSupersededCorrectionConflicts(projectPath, type, payload);
  }
}

/** First word index a transcript correction payload rewrites. */
function correctionStart(payload: Record<string, unknown>): unknown {
  return payload.word_index ?? payload.start_word_index;
}

function isTranscriptCorrection(type: string): boolean {
  return type === "CorrectTranscriptWord" || type === "CorrectTranscriptPhrase";
}

/**
 * After a transcript correction lands, live (submitTranscriptCorrection) or
 * replayed from the offline queue (state/drainOfflineQueue.ts
 * replayQueuedCommands), drop Needs attention entries for earlier refused
 * corrections of the same word (same track and start index), so the banner
 * stops asking the user to redo a correction that has now been made (#746);
 * a no-op for any other command type. A failed cleanup never fails the
 * correction; Dismiss all still clears it.
 */
export async function clearSupersededCorrectionConflicts(
  projectPath: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!isTranscriptCorrection(type)) {
    return;
  }
  const superseded = ({ command }: OfflineConflict) =>
    isTranscriptCorrection(command.type) &&
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

export async function setTranscriptWordAutomatic(
  projectPath: string,
  trackId: string,
  wordIndex: number,
  expectedText?: string | null,
): Promise<void> {
  await submitDocumentCommand(projectPath, "SetTranscriptWordAutomatic", {
    track_id: trackId,
    word_index: wordIndex,
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

async function refreshProjectPhase(
  projectPath: string,
  _phase: "envelopes" | "detail",
): Promise<void> {
  if (useDawStore.getState().projectPath !== projectPath) return;
  const scope = activateDocumentScope(projectPath);
  const snapshot = await loadDocumentState(projectPath, "full");
  if (isCurrentDocumentScope(scope)) applyDocumentSnapshot(snapshot, { scope });
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
    mode: "gap",
  });
}

export async function rippleDeleteClips(
  projectPath: string,
  clipIds: string[],
  confirmCutSpeech = false,
): Promise<RippleOutcome> {
  const result = await submitDocumentCommand(projectPath, "DeleteClip", {
    clip_ids: clipIds,
    mode: "ripple",
    ...confirmed(confirmCutSpeech),
  });
  return rippleOutcome(projectPath, result, {
    cutAnyway: () => rippleDeleteClips(projectPath, clipIds, true),
    leaveGap: () => deleteClips(projectPath, clipIds),
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
    mode: "ripple",
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
