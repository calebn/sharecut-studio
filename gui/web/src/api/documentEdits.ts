import {
  applyDocumentSnapshot,
  redisplayDrafts,
} from "../document/applyDocumentUpdate";
import {
  activateDocumentScope,
  type DocumentScope,
  isCurrentDocumentScope,
} from "../document/authorityState";
import type { EditMode, TrimEdge } from "../edit/clipEdgePreview";
import {
  type DocumentCommandOptions,
  type HistoryCommandType,
  submitLiveHistoryCommand,
  submitQueuedDocumentCommand,
} from "../services/commandQueue";
import { isShareProjectKey, shareTokenFromKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import {
  DocumentCommand,
  type DocumentCommandType,
} from "../types/documentCommands.generated";
import {
  type AutomationPoint,
  type HistoryEntryId,
  type PendingEditView,
  parseHistoryEntryId,
} from "../types/project";
import { ApiError } from "../utils/apiError";
import { type HeldCut, type ReviewOutcome } from "../utils/pendingReviewPass";
import { apiFetch, HOST_KEY } from "./http";
import { loadDocumentState } from "./project";

/** Wire shape for a guarded transcript command's optional stale-text guard. */
function withExpectedText(expectedText?: string | null): {
  expected_text?: string;
} {
  return expectedText == null ? {} : { expected_text: expectedText };
}

export async function submitDocumentCommand(
  projectPath: string,
  type: DocumentCommandType,
  payload: Record<string, unknown> = {},
  opts?: DocumentCommandOptions,
): Promise<Record<string, unknown>> {
  return submitQueuedDocumentCommand(projectPath, type, payload, opts);
}

/** The server refused an undo or redo because history moved past `expectedHeadId`. */
export const HISTORY_STALE_CODE = "history_stale";

export type HistoryMoveOptions = {
  rerender?: boolean;
  scope: DocumentScope;
  /**
   * The head the caller saw (`history.head_id`, `root` before any entry).
   * Required: the server refuses (`history_stale`) once it is not the head.
   */
  expectedHeadId: HistoryEntryId;
};

async function moveHistoryHead(
  type: HistoryCommandType,
  projectPath: string,
  opts: HistoryMoveOptions,
): Promise<HistoryEntryId | null> {
  const result = await submitLiveHistoryCommand(
    projectPath,
    type,
    {
      rerender: opts.rerender ?? false,
      expected_head_id: opts.expectedHeadId,
    },
    opts.scope,
  );
  return replyHistoryHead(result);
}

/** Undo while the captured document opening remains current. */
export function undoHistory(
  projectPath: string,
  opts: HistoryMoveOptions,
): Promise<HistoryEntryId | null> {
  return moveHistoryHead(DocumentCommand.UndoHistory, projectPath, opts);
}

/** Redo while the captured document opening remains current. */
export function redoHistory(
  projectPath: string,
  opts: HistoryMoveOptions,
): Promise<HistoryEntryId | null> {
  return moveHistoryHead(DocumentCommand.RedoHistory, projectPath, opts);
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

function reviewOutcome(result: Record<string, unknown>): ReviewOutcome {
  if (result.queued === true)
    return { queued: true, count: null, historyHead: null, held: [] };
  const command = result.command;
  const payload = isSuggestionRecord(command) ? command.payload : null;
  const review = isSuggestionRecord(payload) ? payload.result : null;
  const count = isSuggestionRecord(review) ? review.count : null;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    throw new Error("The review reply is missing its affected edit count.");
  return {
    queued: false,
    count,
    historyHead: replyHistoryHead(result),
    held: heldOf(review),
  };
}

/** Cuts Approve all left pending, each with the reason the list can show. */
function heldOf(review: unknown): HeldCut[] {
  const held = isSuggestionRecord(review) ? review.held : null;
  if (!Array.isArray(held)) return [];
  return held.flatMap((row): HeldCut[] =>
    isSuggestionRecord(row) &&
    typeof row.id === "string" &&
    typeof row.label === "string" &&
    typeof row.reason === "string"
      ? [{ id: row.id, label: row.label, reason: row.reason }]
      : [],
  );
}

export async function approveEdits(
  projectPath: string,
  ids: string[],
  holdBlocked = false,
  refineRecoveryInline = false,
  opts?: { skipUnsure?: true },
): Promise<ReviewOutcome> {
  const result = await submitDocumentCommand(
    projectPath,
    DocumentCommand.ApproveEdits,
    {
      ids,
      ...(holdBlocked ? { hold_blocked: true } : {}),
      ...(opts?.skipUnsure ? { skip_unsure: true } : {}),
    },
    refineRecoveryInline ? { refineRecoveryInline } : undefined,
  );
  return reviewOutcome(result);
}

export async function waiveTranscriptRefine(
  projectPath: string,
  reason: string,
): Promise<void> {
  await apiFetch(
    HOST_KEY,
    { host: "/api/transcript/refine/waive" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath, reason }),
    },
  );
}

export interface SuggestedActionsOutcome {
  /** Saved and sent later by the drain, so the outcome is not known yet. */
  queued: boolean;
  summary: string | null;
  historyHead: HistoryEntryId | null;
  /** Lowers the server left as they are because nobody talks over them. */
  loweredToLeave?: number;
  /** Ids the server could not apply; they stay pending. */
  held?: string[];
}

/**
 * Apply every listed sound's own suggested action in one undo step. With `revise`, change
 * `overrides` sounds of the batch just applied instead (it takes no `ids`).
 */
export async function applySuggestedActions(
  projectPath: string,
  ids: string[] | null,
  overrides: Record<string, string> = {},
  revise = false,
): Promise<SuggestedActionsOutcome> {
  const result = await submitDocumentCommand(
    projectPath,
    DocumentCommand.ApplySuggestedActions,
    {
      ...(ids ? { ids } : {}),
      ...(Object.keys(overrides).length ? { overrides } : {}),
      ...(revise ? { revise: true } : {}),
    },
  );
  if (result.queued === true)
    return { queued: true, summary: null, historyHead: null };
  const command = result.command;
  const payload = isSuggestionRecord(command) ? command.payload : null;
  const done = isSuggestionRecord(payload) ? payload.result : null;
  const summary =
    isSuggestionRecord(done) && typeof done.summary === "string"
      ? done.summary
      : null;
  const record = isSuggestionRecord(done) ? done : {};
  return {
    queued: false,
    summary,
    historyHead: replyHistoryHead(result),
    loweredToLeave:
      typeof record.lowered_to_leave === "number" ? record.lowered_to_leave : 0,
    held: Array.isArray(record.held)
      ? record.held.filter((h): h is string => typeof h === "string")
      : [],
  };
}

/** `queued`: saved and sent later by the drain, so the outcome is not known yet. */
export async function rejectEdits(
  projectPath: string,
  ids: string[],
): Promise<ReviewOutcome> {
  const result = await submitDocumentCommand(
    projectPath,
    DocumentCommand.RejectEdits,
    {
      ids,
    },
  );
  return reviewOutcome(result);
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
  if (isShareProjectKey(projectPath) && !shareTokenFromKey(projectPath)) {
    throw new Error("Invalid guest cut suggestion project key");
  }
  const endpoint = `/pending-edits/${encodeURIComponent(edit.id)}/cut-suggestion`;
  const response = await apiFetch(
    projectPath,
    {
      host: `/api${endpoint}?${new URLSearchParams({ path: projectPath })}`,
      guest: `/daw${endpoint}`,
    },
    { signal },
  );
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
  const result = await submitDocumentCommand(
    projectPath,
    DocumentCommand.UpdatePendingEdit,
    {
      id,
      start,
      end,
      snap,
      ...(trackIds != null ? { track_ids: trackIds } : {}),
      ...(expected ? { expected } : {}),
    },
  );
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
  await submitDocumentCommand(projectPath, DocumentCommand.RestoreAppliedEdit, {
    id,
  });
}

export type ClipFadeBaseline = Readonly<{
  fade_in_ms: number;
  fade_out_ms: number;
}>;

export async function setClipFade(
  projectPath: string,
  clipId: string,
  fadeInMs: number,
  fadeOutMs: number,
  expected: ClipFadeBaseline,
): Promise<HistoryEntryId | null> {
  return replyHistoryHead(
    await submitDocumentCommand(projectPath, DocumentCommand.SetClipFade, {
      clip_id: clipId,
      fade_in_ms: fadeInMs,
      fade_out_ms: fadeOutMs,
      expected: { ...expected },
    }),
  );
}

export async function trimClipEdge(
  projectPath: string,
  clipId: string,
  edge: TrimEdge,
  sourceSec: number,
  mode: EditMode,
  expectedToken: string,
): Promise<{ queued: boolean; undo: HistoryEntryId | null }> {
  const result = await submitDocumentCommand(
    projectPath,
    DocumentCommand.TrimClipEdge,
    {
      clip_id: clipId,
      edge,
      source_sec: sourceSec,
      mode,
      expected_token: expectedToken,
    },
  );
  return { queued: result.queued === true, undo: replyHistoryHead(result) };
}

export async function rollClipJoin(
  projectPath: string,
  leftClipId: string,
  rightClipId: string,
  deltaSec: number,
  expectedToken: string,
): Promise<{ queued: boolean }> {
  const result = await submitDocumentCommand(
    projectPath,
    DocumentCommand.RollClipJoin,
    {
      left_clip_id: leftClipId,
      right_clip_id: rightClipId,
      delta_sec: deltaSec,
      expected_token: expectedToken,
    },
  );
  return { queued: result.queued === true };
}

export async function moveClips(
  projectPath: string,
  clips: Array<{
    clip_id: string;
    timeline_start: number;
    track_id: string;
  }>,
): Promise<HistoryEntryId | null> {
  return replyHistoryHead(
    await submitDocumentCommand(projectPath, DocumentCommand.MoveClips, {
      clips,
    }),
  );
}

/** Set a join's mode and both edge fades in one undo step. */
export async function setClipJoin(
  projectPath: string,
  leftClipId: string,
  rightClipId: string,
  mode: string,
  lengthMs?: number | null,
): Promise<void> {
  await submitDocumentCommand(projectPath, DocumentCommand.SetClipJoin, {
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
  await submitDocumentCommand(
    projectPath,
    DocumentCommand.ApplyFadeRecommendations,
    {
      track_id: trackId ?? null,
    },
  );
}

export async function setEffectBypass(
  projectPath: string,
  trackId: string,
  effectIndex: number,
  bypass: boolean,
): Promise<void> {
  await submitDocumentCommand(projectPath, DocumentCommand.SetEffectBypass, {
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
 * so Apply again retries against the current text (#746).
 */
async function submitTranscriptCorrection(
  projectPath: string,
  type:
    | typeof DocumentCommand.CorrectTranscriptWord
    | typeof DocumentCommand.CorrectTranscriptPhrase,
  payload: Record<string, unknown>,
): Promise<HistoryEntryId | null> {
  let result: Record<string, unknown>;
  try {
    result = await submitDocumentCommand(projectPath, type, payload);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      await refreshProjectPhase(projectPath, "detail").catch(() => undefined);
    }
    throw error;
  }
  return replyHistoryHead(result);
}

export async function correctTranscriptWord(
  projectPath: string,
  trackId: string,
  wordIndex: number,
  text: string,
  expectedText?: string | null,
  sourceId?: string | null,
): Promise<HistoryEntryId | null> {
  return submitTranscriptCorrection(
    projectPath,
    DocumentCommand.CorrectTranscriptWord,
    {
      track_id: trackId,
      ...(sourceId != null ? { source_id: sourceId } : {}),
      word_index: wordIndex,
      text,
      ...withExpectedText(expectedText),
    },
  );
}

export async function correctTranscriptPhrase(
  projectPath: string,
  trackId: string,
  startWordIndex: number,
  endWordIndex: number,
  text: string,
  expectedText?: string | null,
  sourceId?: string | null,
): Promise<HistoryEntryId | null> {
  return submitTranscriptCorrection(
    projectPath,
    DocumentCommand.CorrectTranscriptPhrase,
    {
      track_id: trackId,
      ...(sourceId != null ? { source_id: sourceId } : {}),
      start_word_index: startWordIndex,
      end_word_index: endWordIndex,
      text,
      ...withExpectedText(expectedText),
    },
  );
}

export async function setTranscriptWordSuppressed(
  projectPath: string,
  trackId: string,
  wordIndex: number,
  suppressed: boolean,
  expectedText?: string | null,
  sourceId?: string | null,
): Promise<HistoryEntryId | null> {
  const result = await submitDocumentCommand(
    projectPath,
    DocumentCommand.SetTranscriptWordSuppressed,
    {
      track_id: trackId,
      ...(sourceId != null ? { source_id: sourceId } : {}),
      word_index: wordIndex,
      suppressed,
      ...withExpectedText(expectedText),
    },
  );
  return replyHistoryHead(result);
}

export async function setTranscriptWordAutomatic(
  projectPath: string,
  trackId: string,
  wordIndex: number,
  expectedText?: string | null,
  sourceId?: string | null,
): Promise<HistoryEntryId | null> {
  const result = await submitDocumentCommand(
    projectPath,
    DocumentCommand.SetTranscriptWordAutomatic,
    {
      track_id: trackId,
      ...(sourceId != null ? { source_id: sourceId } : {}),
      word_index: wordIndex,
      ...withExpectedText(expectedText),
    },
  );
  return replyHistoryHead(result);
}

export async function setTranscriptWordsIgnored(
  projectPath: string,
  trackId: string,
  startWordIndex: number,
  endWordIndex: number,
  ignored: boolean,
  expectedText?: string | null,
  sourceId?: string | null,
): Promise<HistoryEntryId | null> {
  const result = await submitDocumentCommand(
    projectPath,
    DocumentCommand.SetTranscriptWordsIgnored,
    {
      track_id: trackId,
      ...(sourceId != null ? { source_id: sourceId } : {}),
      start_word_index: startWordIndex,
      end_word_index: endWordIndex,
      ignored,
      ...withExpectedText(expectedText),
    },
  );
  return replyHistoryHead(result);
}

export async function setEnvelope(
  projectPath: string,
  trackId: string,
  points: AutomationPoint[],
  expectedPoints: AutomationPoint[],
): Promise<HistoryEntryId | null> {
  let result: Record<string, unknown>;
  try {
    result = await submitDocumentCommand(
      projectPath,
      DocumentCommand.SetEnvelope,
      {
        track_id: trackId,
        points,
        // Echo the store's points verbatim: the host compares floats exactly.
        expected_points: expectedPoints,
      },
    );
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
    // The envelope draft the submit began still holds them.
    if (useDawStore.getState().projectPath === projectPath) redisplayDrafts();
  }
  return replyHistoryHead(result);
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

export async function addChapter(
  projectPath: string,
  time: number,
  title: string,
): Promise<HistoryEntryId | null> {
  return replyHistoryHead(
    await submitDocumentCommand(projectPath, DocumentCommand.AddChapter, {
      time,
      title,
    }),
  );
}

export async function updateChapter(
  projectPath: string,
  oldTime: number,
  oldTitle: string,
  time: number,
  title: string,
): Promise<void> {
  await submitDocumentCommand(projectPath, DocumentCommand.UpdateChapter, {
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
  await submitDocumentCommand(projectPath, DocumentCommand.DeleteChapter, {
    time,
    title,
  });
}

export async function addSocialClip(
  projectPath: string,
  trackId: string,
  start: number,
  end: number,
  title?: string | null,
): Promise<void> {
  await submitDocumentCommand(projectPath, DocumentCommand.AddSocialClip, {
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
  await submitDocumentCommand(projectPath, DocumentCommand.UpdateSocialClip, {
    id,
    start,
    end,
  });
}

export async function deleteSocialClip(
  projectPath: string,
  id: string,
): Promise<void> {
  await submitDocumentCommand(projectPath, DocumentCommand.DeleteSocialClip, {
    id,
  });
}

export async function splitAtTime(
  projectPath: string,
  atTime: number,
  trackIds?: string[] | null,
  reason?: string | null,
  extraAtTimes?: readonly number[],
): Promise<HistoryEntryId | null> {
  return replyHistoryHead(
    await submitDocumentCommand(projectPath, DocumentCommand.SplitAtTime, {
      at_time: atTime,
      track_ids: trackIds ?? null,
      reason: reason ?? null,
      ...(extraAtTimes?.length ? { extra_at_times: [...extraAtTimes] } : {}),
    }),
  );
}

export async function deleteClips(
  projectPath: string,
  clipIds: string[],
): Promise<HistoryEntryId | null> {
  return replyHistoryHead(
    await submitDocumentCommand(projectPath, DocumentCommand.DeleteClip, {
      clip_ids: clipIds,
      mode: "gap",
    }),
  );
}

export async function rippleDeleteClips(
  projectPath: string,
  clipIds: string[],
): Promise<HistoryEntryId | null> {
  return replyHistoryHead(
    await submitDocumentCommand(projectPath, DocumentCommand.DeleteClip, {
      clip_ids: clipIds,
      mode: "ripple",
    }),
  );
}

export async function duplicateSegment(
  projectPath: string,
  sourceStart: number,
  sourceEnd: number,
  insertAt: number,
): Promise<HistoryEntryId | null> {
  return replyHistoryHead(
    await submitDocumentCommand(projectPath, DocumentCommand.DuplicateSegment, {
      source_start: sourceStart,
      source_end: sourceEnd,
      insert_at: insertAt,
    }),
  );
}

export async function moveSegment(
  projectPath: string,
  sourceStart: number,
  sourceEnd: number,
  insertAt: number,
): Promise<void> {
  await submitDocumentCommand(projectPath, DocumentCommand.MoveSegment, {
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
): Promise<HistoryEntryId | null> {
  return replyHistoryHead(
    await submitDocumentCommand(projectPath, DocumentCommand.PasteSegment, {
      insert_at: insertAt,
      duration,
      extracts,
      mode: "ripple",
    }),
  );
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
  return submitDocumentCommand(projectPath, DocumentCommand.AddTrack, {
    ...(opts ?? {}),
  });
}

export async function setTrackMediaCommand(
  projectPath: string,
  trackId: string,
  relPath: string,
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, DocumentCommand.SetTrackMedia, {
    track_id: trackId,
    rel_path: relPath,
  });
}

export async function renameProjectCommand(
  projectPath: string,
  name: string,
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, DocumentCommand.RenameProject, {
    name,
  });
}

/** Name a landed record session; an empty name clears it back to the default heading. */
export async function setRecordSessionNameCommand(
  projectPath: string,
  sessionId: string,
  name: string,
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(
    projectPath,
    DocumentCommand.SetRecordSessionName,
    { session_id: sessionId, name },
  );
}

/** Place a pending staged record session; the reply may carry `needs_confirmation` for a held replace. */
export async function acceptSessionSuggestionCommand(
  projectPath: string,
  suggestionId: string,
  options: { takeIndex?: number; overrideAudioChecks?: boolean } = {},
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(
    projectPath,
    DocumentCommand.AcceptSessionSuggestion,
    {
      suggestion_id: suggestionId,
      ...(options.takeIndex === undefined
        ? {}
        : { take_index: options.takeIndex }),
      override_audio_checks: options.overrideAudioChecks ?? false,
    },
  );
}

/** Skip a pending staged record session; its sources stay registered. */
export async function skipSessionSuggestionCommand(
  projectPath: string,
  suggestionId: string,
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(
    projectPath,
    DocumentCommand.SkipSessionSuggestion,
    { suggestion_id: suggestionId },
  );
}

/** Pick the take Accept places for a pending replace. */
export async function selectSessionTakeCommand(
  projectPath: string,
  suggestionId: string,
  takeIndex: number,
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, DocumentCommand.SelectSessionTake, {
    suggestion_id: suggestionId,
    take_index: takeIndex,
  });
}

export async function setTrackMetaCommand(
  projectPath: string,
  trackId: string,
  opts: { label?: string; role?: string; speaker?: string },
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, DocumentCommand.SetTrackMeta, {
    track_id: trackId,
    ...opts,
  });
}

export async function setTrackFaderCommand(
  projectPath: string,
  trackId: string,
  faderDb: number,
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, DocumentCommand.SetTrackFader, {
    track_id: trackId,
    fader_db: faderDb,
  });
}

export async function setTrackMuteCommand(
  projectPath: string,
  trackId: string,
  muted: boolean,
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, DocumentCommand.SetTrackMute, {
    track_id: trackId,
    muted,
  });
}

export async function removeTrackCommand(
  projectPath: string,
  trackId: string,
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, DocumentCommand.RemoveTrack, {
    track_id: trackId,
  });
}

export async function reorderTrackCommand(
  projectPath: string,
  trackId: string,
  index: number,
): Promise<Record<string, unknown>> {
  return submitDocumentCommand(projectPath, DocumentCommand.ReorderTrack, {
    track_id: trackId,
    index,
  });
}
