import {
  applyFadeRecommendations,
  applySuggestedActions,
  approveEdits,
  deleteChapter,
  deleteComment,
  deleteSocialClip,
  rejectEdits,
  updateSocialClipDetails,
} from "../api";
import { playPendingPreview } from "../audio/pendingPreview";
import { getClipboard } from "../edit/clipboard";
import {
  type EditFacts,
  type EditKind,
  type EditRole,
  editFacts,
} from "../edit/editSelection";
import { JOIN_MODES, joinTypeChoices } from "../edit/joinType";
import {
  lastClipEndSec,
  replaceableSpan,
  replaceTargetOf,
  scriptOf,
} from "../edit/pickupTarget";
import {
  makeRangeTarget,
  rangeIsCurrent,
  resolveSelectionRange,
} from "../edit/rangeSelection";
import { keepPlan, type Seam, seamById } from "../edit/seam";
import {
  canApplyPass12,
  canManageProjects,
  canReviewPendingEdit,
  commentRole,
  hasShareCapability,
  rangeEditMode,
} from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { inspectorOpenFor, selectedClipIdsOf } from "../state/selection";
import type { PendingRecordTarget } from "../state/stageSlice";
import type { BarItem } from "../system/actionBarSlots";
import { type BarId, resolveBar } from "../system/editActionSets";
import type { HistoryEntryId, ProjectView, Selection } from "../types/project";
import { BUSY_REASON } from "../ui/disabledReason";
import { errorMessage } from "../utils/apiError";
import { commitCommentActor } from "../utils/commentAuthor";
import { joinModeOf } from "../utils/editMarkerRegistry";
import {
  capturePendingReview,
  finishPendingReview,
} from "../utils/pendingReviewPass";
import { oneWordOf, wordSelection } from "../utils/rangeSelect";
import {
  siblingSplitLanes,
  speakerLaneMoveTarget,
} from "../utils/speakerSplit";
import { COMMANDS } from "./catalog";
import { bleedKeepReason, selectedBleedRegion } from "./clipBleed";
import { buildCommandContext, evaluateWhen } from "./context";
import { runDeleteClips } from "./editing";
import { inProject, removeEnvelopePoint } from "./envelopes";
import { registerCommand } from "./execute";
import { decideThroughSheet, sheetBusyReason } from "./pendingDecision";
import { playSpan } from "./playSpan";
import { executePointerCommand } from "./pointer";
import {
  armRangeDraft,
  PLAY_FULL_MIX_LABEL,
  rangeActionDescriptors,
  runRangeAction,
} from "./rangeActions";
import { announceRefusal } from "./refusal";
import {
  EDITING_OFF_REASON,
  hearAcross,
  replayIfInspected,
  restoreSeam,
  setSeamJoin,
} from "./seamCommands";
import { seekTransport } from "./seek";
import { ignoreWouldRestore } from "./transcriptIgnore";
import { requestInlineEdit } from "./transcriptWord";
import type { ExecuteResult } from "./types";
import { wordUnderPlayhead } from "./wordUnderPlayhead";

type VerbArg = string | undefined;

const disabled = (reason: string): ExecuteResult => ({
  status: "disabled",
  reason,
});
const OK: ExecuteResult = { status: "ok" };

type DawState = ReturnType<typeof useDawStore.getState>;

function editRoleOf(
  s: Pick<DawState, "projectPath" | "shareCapabilities">,
): EditRole {
  if (canManageProjects(s.projectPath)) return "host";
  return rangeEditMode(s.projectPath, s.shareCapabilities) === "none"
    ? "readOnly"
    : "editor";
}

export function editFactsOf(
  s: Pick<
    DawState,
    "selection" | "project" | "projectPath" | "shareCapabilities"
  >,
): EditFacts | null {
  if (!s.project) return null;
  return editFacts(s.selection, s.project, {
    role: editRoleOf(s),
    clipboardHasAudio: getClipboard() != null,
  });
}

export function currentEditFacts(
  s: DawState = useDawStore.getState(),
): EditFacts | null {
  return editFactsOf(s);
}

const HEAR_PAD_SEC = 1;
const MARKER_HEAR_SEC = 3;

function currentSeam(): Seam | null {
  const { project, selection } = useDawStore.getState();
  return project && selection?.kind === "seam"
    ? seamById(project, selection.id)
    : null;
}

async function setJoinType(arg: VerbArg): Promise<ExecuteResult> {
  const mode = JOIN_MODES.find((candidate) => candidate === arg);
  const seam = currentSeam();
  if (!mode || !seam) return disabled("Select a seam to change its join type");
  const result = await setSeamJoin(seam, mode, null);
  if (result.status === "failed") {
    return { status: "disabled", reason: result.message, told: true };
  }
  if (result.status === "done") replayIfInspected(seam.id);
  return OK;
}

function joinTypeItem(s: DawState): BarItem | null {
  const { project, selection } = s;
  if (
    !project ||
    selection?.kind !== "seam" ||
    !canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities)
  )
    return null;
  const seam = seamById(project, selection.id);
  if (!seam?.abuts) return null;
  const mode = joinModeOf(seam.right);
  return {
    id: "joinType",
    ...(s.joinMutationInFlight ? { disabledReason: BUSY_REASON } : {}),
    options: joinTypeChoices(seam, project).map((option) => ({
      ...option,
      pressed: option.value === mode,
    })),
  };
}

async function hearVerb(facts: EditFacts): Promise<ExecuteResult> {
  switch (facts.kind) {
    case "words":
    case "range":
      return executePointerCommand("range.play");
    case "clip":
      return facts.span
        ? playSpan(facts.span.start, facts.span.end, 0)
        : disabled("Select a clip to hear it");
    case "seam": {
      const seam = currentSeam();
      return seam ? hearAcross(seam) : disabled("This seam is gone");
    }
    case "chapter":
    case "social":
    case "comment":
      return facts.span
        ? playSpan(facts.span.start, facts.span.start + MARKER_HEAR_SEC, 0)
        : disabled("Nothing to hear here");
    case "suggestion":
      return hearSide(facts, null);
    case "envelopePoint": {
      const s = useDawStore.getState();
      const at = envelopePointTime(s.project, s.selection);
      return at === null
        ? disabled("Nothing to hear here")
        : playSpan(Math.max(0, at - HEAR_PAD_SEC), at + HEAR_PAD_SEC, 0);
    }
    default:
      return disabled("Nothing to hear here");
  }
}

function envelopePointTime(
  project: ProjectView | null,
  selection: Selection,
): number | null {
  if (selection?.kind !== "envelopePoint") return null;
  const { trackId, pointId } = selection;
  const point = project?.envelopes
    .find((e) => e.track_id === trackId)
    ?.points.find((p) => p.id === pointId);
  return point ? point.time : null;
}

/**
 * Plays the server-rendered preview of the selected suggestion. `null` is plain Hear (the only
 * hear a read-only guest's bar has): the suggested side, or the current side where the server
 * cannot render a suggested one.
 */
async function hearSide(
  facts: EditFacts,
  side: "current" | "suggested" | null,
): Promise<ExecuteResult> {
  if (facts.kind === "bleed") return hearBleed(side === "current");
  const s = useDawStore.getState();
  if (facts.kind !== "suggestion" || s.selection?.kind !== "pending")
    return disabled("Select a suggestion to hear it");
  const id = s.selection.id;
  const mode =
    side ??
    (s.project?.pending_edits.find((e) => e.id === id)?.suggest_reason
      ? "current"
      : "suggested");
  const outcome = await playPendingPreview(s.projectPath, id, mode);
  if (outcome.status === "ok" || outcome.status === "superseded") return OK;
  return disabled(outcome.reason);
}

/**
 * Before is the source audio as recorded, after is the full mix with the reduction applied.
 */
async function hearBleed(before: boolean): Promise<ExecuteResult> {
  const region = selectedBleedRegion();
  if (!region) return disabled("Select one automatic region below");
  const mode = await executePointerCommand("transport.audition", {
    mode: before ? "raw" : "mix",
  });
  if (mode.status !== "ok") return mode;
  const { start, end } = region.timelineSpan;
  return playSpan(start, end, HEAR_PAD_SEC);
}

/** Moves the playhead to the start of the selected suggestion. */
async function seekPending(facts: EditFacts): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (facts.kind !== "suggestion" || s.selection?.kind !== "pending")
    return disabled("Select a suggestion to seek to it");
  const id = s.selection.id;
  const edit = s.project?.pending_edits.find((e) => e.id === id);
  const at = edit ? (edit.timeline_start ?? edit.source_start) : null;
  if (at == null)
    return disabled("This suggestion has no place on the timeline");
  return seekTransport(at);
}

/**
 * The bar's Cut for a shorten or lower suggestion, for the timeline overlay bar to share: applies
 * the suggestion's own action behind the open sheet's busy gate, with the same announcements.
 */
export function applyPendingSuggestion(): Promise<ExecuteResult> {
  return decidePending("suggested");
}

async function decidePending(
  action: "approve" | "reject" | "suggested",
): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  const selection = s.selection;
  if (selection?.kind !== "pending" || !s.project)
    return disabled("Select a suggestion first");
  const edit = s.project.pending_edits.find((e) => e.id === selection.id);
  if (!edit || edit.applied) return disabled("That suggestion is gone");
  if (!canReviewPendingEdit(s.projectPath, s.shareCapabilities))
    return disabled("This link cannot decide suggestions");
  try {
    if (action === "suggested") {
      const busy = sheetBusyReason(edit.id);
      if (busy) return disabled(busy);
      const outcome = await applySuggestedActions(s.projectPath, [edit.id]);
      const live = useDawStore.getState();
      if (outcome.queued) {
        live.announceStatus("Saved. It sends when you reconnect.");
        return OK;
      }
      live.announceStatus(outcome.summary ?? "Applied the suggestion", {
        undo: outcome.historyHead,
      });
      if (live.selection === selection) live.setSelection(null);
      return OK;
    }
    const sheet = await decideThroughSheet(edit.id, action);
    if (sheet) return sheet;
    const capture = capturePendingReview(action, s.projectPath, edit);
    const outcome =
      action === "approve"
        ? await approveEdits(s.projectPath, [edit.id], false, true)
        : await rejectEdits(s.projectPath, [edit.id]);
    finishPendingReview(capture, outcome);
    return OK;
  } catch (error) {
    const reason = errorMessage(error);
    useDawStore.getState().announceStatus(reason, { tone: "error" });
    return { status: "disabled", reason, told: true };
  }
}

async function keep(facts: EditFacts): Promise<ExecuteResult> {
  if (facts.kind === "suggestion") return decidePending("reject");
  if (facts.kind === "bleed")
    return executePointerCommand("edit.restoreClipBleed");
  if (facts.kind === "seam") {
    const seam = currentSeam();
    if (seam?.kind !== "cut") return disabled("Nothing was cut here");
    return restoreSeam(seam);
  }
  if (facts.kind === "words") {
    if (!facts.holdsCut) return disabled("Nothing was cut here");
    // The server restores a mute but not a removal; a removal comes back with
    // History's Undo, which is the honest way to say Keep.
    const opened = await executePointerCommand("edit.history");
    if (opened.status === "ok")
      useDawStore
        .getState()
        .announceStatus("A cut comes back with Undo. History is open.");
    return opened;
  }
  return disabled("Nothing to keep here");
}

async function runCutSelection(
  args: Record<string, unknown> = {},
): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  const selection = s.selection;
  if (typeof args.clipId === "string" && args.clipId)
    return runDeleteClips([args.clipId], false);
  switch (selection?.kind) {
    case "clip":
      return runDeleteClips([...selectedClipIdsOf(selection)], false);
    case "range":
    case "transcriptRange":
      return runRangeAction("cut");
    case "pending": {
      const edit = s.project?.pending_edits.find((e) => e.id === selection.id);
      if (edit?.suggested_action && edit.suggested_action !== "cut")
        return decidePending("suggested");
      return decidePending("approve");
    }
    case "chapter":
    case "envelopePoint":
      return removeMarker(selection);
    default:
      if (!selection && s.isPlaying && s.stage === "edit")
        return selectWordUnderPlayhead();
      return disabled(
        selection
          ? "There is nothing to cut in this selection"
          : "No clip selected",
      );
  }
}

function selectWordUnderPlayhead(): ExecuteResult {
  const s = useDawStore.getState();
  const word = s.project
    ? wordUnderPlayhead(
        s.project,
        s.playheadSec,
        s.rangeDraft?.trackIds ?? null,
        s,
      )
    : null;
  if (!word) return disabled("No word under the playhead");
  s.stopFollow("local");
  s.setIsPlaying(false);
  s.setSelection(wordSelection(word));
  s.announceStatus(`Selected "${word.text}". Cut it to remove`);
  return OK;
}

/** Host only, like the social clip's own Inspector. */
async function approveSocial(): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (s.selection?.kind !== "social") return disabled("Select a social clip");
  if (!canManageProjects(s.projectPath))
    return disabled("Only the host can approve a social clip");
  try {
    await updateSocialClipDetails(s.projectPath, s.selection.id, {
      approved: true,
    });
    useDawStore.getState().announceStatus("Social clip approved");
    return OK;
  } catch (error) {
    return disabled(errorMessage(error));
  }
}

async function removeRecord(
  id: string,
  noun: string,
  hostReason: string,
  remove: (path: string, id: string) => Promise<HistoryEntryId | null>,
): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (!canManageProjects(s.projectPath)) return disabled(hostReason);
  try {
    const undo = await remove(s.projectPath, id);
    useDawStore.getState().setSelection(null);
    useDawStore.getState().announceStatus(`${noun} removed`, { undo });
    return OK;
  } catch (error) {
    return disabled(errorMessage(error));
  }
}

const removeSocial = (id: string) =>
  removeRecord(
    id,
    "Social clip",
    "Only the host can remove a social clip",
    deleteSocialClip,
  );

const removeComment = (id: string) =>
  removeRecord(
    id,
    "Comment",
    "Only the host can remove a comment",
    deleteComment,
  );

async function resolveComment(): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (s.selection?.kind !== "comment") return disabled("Select a comment");
  const by = commitCommentActor(
    undefined,
    commentRole(s.projectPath, s.guestMode),
  );
  const commentId = s.selection.id;
  const result = await executePointerCommand("comment.resolve", {
    commentId,
    resolved: true,
    by,
  });
  if (result.status === "ok")
    useDawStore.getState().announceStatus("Comment resolved", {
      reverse: {
        run: async () => {
          if (useDawStore.getState().projectPath !== s.projectPath)
            return false;
          const back = await executePointerCommand("comment.resolve", {
            commentId,
            resolved: false,
            by,
          });
          return back.status === "ok";
        },
        done: "Comment reopened",
      },
    });
  return result;
}

const SMOOTH_ONE_TRACK = "Select one track to smooth its joins";

async function smoothJoins(): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  const selection = s.selection;
  if (selection?.kind !== "track") return disabled(SMOOTH_ONE_TRACK);
  if (selection.trackIds && selection.trackIds.length > 1)
    return disabled(SMOOTH_ONE_TRACK);
  if (!canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities))
    return disabled(EDITING_OFF_REASON);
  try {
    await applyFadeRecommendations(s.projectPath, selection.trackId);
    return OK;
  } catch (error) {
    const reason = errorMessage(error);
    useDawStore.getState().announceStatus(reason, { tone: "error" });
    return { status: "disabled", reason, told: true };
  }
}

async function removeMarker(
  selection: Extract<Selection, { kind: "chapter" | "envelopePoint" }>,
): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  try {
    if (selection.kind === "chapter") {
      if (!canManageProjects(s.projectPath))
        return disabled("Only the host can remove a chapter");
      await deleteChapter(s.projectPath, selection.time, selection.id);
      useDawStore.getState().setSelection(null);
      useDawStore.getState().announceStatus("Chapter removed");
      return OK;
    }
    const written = await removeEnvelopePoint(
      selection.trackId,
      selection.pointId,
    );
    if (written.status === "ok") return OK;
    if (inProject(s))
      useDawStore.getState().announceStatus(written.reason, { tone: "error" });
    return { status: "disabled", reason: written.reason, told: true };
  } catch (error) {
    const reason = errorMessage(error);
    useDawStore.getState().announceStatus(reason, { tone: "error" });
    return { status: "disabled", reason, told: true };
  }
}

export function splitPlan(
  facts: EditFacts,
  selection: Selection,
  project: ProjectView,
  playheadSec: number,
): { atTime: number; extraAtTimes: number[]; trackIds?: string[] } | string {
  if (facts.kind === "words" || facts.kind === "range") {
    if (!facts.span) return "This selection has no place on the timeline";
    const trackIds = [...facts.span.trackIds];
    const edges = [facts.span.start, facts.span.end];
    return {
      atTime: edges[0]!,
      extraAtTimes: edges[1]! > edges[0]! ? [edges[1]!] : [],
      ...(trackIds.length ? { trackIds } : {}),
    };
  }
  if (facts.kind === "clip") {
    const ids = new Set(selectedClipIdsOf(selection));
    const clips = Object.values(project.clips.tracks)
      .flat()
      .filter((clip) => ids.has(clip.id));
    const inside = clips.filter(
      (clip) =>
        playheadSec > clip.timeline_start && playheadSec < clip.timeline_end,
    );
    if (!inside.length) return "Move the playhead onto the clip to split it";
    return {
      atTime: playheadSec,
      extraAtTimes: [],
      trackIds: [...new Set(inside.map((clip) => clip.track_id))],
    };
  }
  return { atTime: playheadSec, extraAtTimes: [] };
}

async function split(facts: EditFacts): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (!s.project) return disabled("No project loaded");
  const plan = splitPlan(facts, s.selection, s.project, s.playheadSec);
  if (typeof plan === "string") return disabled(plan);
  return executePointerCommand("edit.bladeCut", plan);
}

async function comment(facts: EditFacts): Promise<ExecuteResult> {
  if (facts.kind === "words" || facts.kind === "range")
    return executePointerCommand("range.comment");
  if (facts.kind === "seam" && facts.span)
    return executePointerCommand("comment.draftAt", {
      atTime: facts.span.start,
      trackId: facts.span.trackIds[0],
    });
  return executePointerCommand("comment.draftAt", {});
}

/** Open Record, then park the target for its room; a refusal parks nothing. */
async function openRecordWith(
  target: PendingRecordTarget,
): Promise<ExecuteResult> {
  const opened = await executePointerCommand("stage.record");
  if (opened.status !== "ok") return opened;
  useDawStore.getState().setPendingRecordTarget(target);
  return opened;
}

/**
 * The Record verb from Edit. Over words or a range it is Re-record: a pickup
 * that replaces the selection. On the playhead it is Record here: an insert.
 */
async function record(facts: EditFacts): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (!canManageProjects(s.projectPath))
    return disabled("Only the host can record");
  if (facts.kind === "words" || facts.kind === "range") {
    const span = replaceableSpan(facts.span, s.project);
    if (!span) return disabled("Select words or a range on the timeline first");
    return openRecordWith(
      replaceTargetOf(span, scriptOf(s.selection, s.project)),
    );
  }
  return recordHere();
}

/**
 * Record here: open Record with an Insert target, at `atSec` (the held time of
 * the create menu) or else the playhead. Host only. On an empty timeline there
 * is nothing to insert into, so Record opens with its default target.
 */
export async function recordHere(atSec?: number): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (!canManageProjects(s.projectPath))
    return disabled("Only the host can record");
  if (lastClipEndSec(s.project) === undefined)
    return executePointerCommand("stage.record");
  return openRecordWith({ kind: "insert", at_sec: atSec ?? s.playheadSec });
}

function singleClipTarget(project: ProjectView, selection: Selection) {
  const ids = selectedClipIdsOf(selection);
  if (ids.length !== 1) return null;
  const clip = Object.values(project.clips.tracks)
    .flat()
    .find((entry) => entry.id === ids[0]);
  return clip
    ? makeRangeTarget(
        project,
        [{ start: clip.timeline_start, end: clip.timeline_end }],
        [clip.track_id],
      )
    : null;
}

export async function runMute(): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (s.stage !== "edit") return executePointerCommand("track.muteToggle");
  switch (s.selection?.kind) {
    case "transcriptRange": {
      const restore = wordsRestoreAvailability(s);
      if (restore?.reason) return disabled(restore.reason);
      return executePointerCommand(
        canManageProjects(s.projectPath)
          ? "transcript.ignoreWords"
          : "range.mute",
      );
    }
    case "range":
      return executePointerCommand("range.mute");
    case "clip": {
      const target = s.project
        ? singleClipTarget(s.project, s.selection)
        : null;
      if (!target)
        return disabled(
          selectedClipIdsOf(s.selection).length > 1
            ? "Select one clip to mute it"
            : "Nothing audible to mute",
        );
      return runRangeAction("mute", target);
    }
    default:
      return executePointerCommand("track.muteToggle");
  }
}

export async function runEditVerb(
  id: BarId,
  facts: EditFacts,
  arg?: VerbArg,
): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  const live = currentEditFacts(s);
  if (!live || live.kind !== facts.kind)
    return announceRefusal(disabled("The selection changed. Try again."));
  return announceRefusal(await dispatch(id, live, arg));
}

async function dispatch(
  id: BarId,
  facts: EditFacts,
  arg: VerbArg,
): Promise<ExecuteResult> {
  switch (id) {
    case "hear":
      return hearVerb(facts);
    case "seek":
      return seekPending(facts);
    case "hearBefore":
      return hearSide(facts, "current");
    case "hearAfter":
      return hearSide(facts, "suggested");
    case "cut":
      return executePointerCommand("edit.delete");
    case "shorten":
    case "lower":
      return decidePending("suggested");
    case "keep":
      return keep(facts);
    case "split":
      return split(facts);
    case "addChapter":
      return executePointerCommand("edit.addChapter");
    case "comment":
      return comment(facts);
    case "fixText": {
      // A chapter's text is its Title field, the Inspector's first control.
      if (facts.kind === "chapter")
        return executePointerCommand("edit.inspect", { open: true });
      const word = oneWordOf(useDawStore.getState().selection);
      return word
        ? requestInlineEdit(word.trackId, word.sourceId ?? null, word.wordIndex)
        : disabled("Select one word to fix its text");
    }
    case "record":
      return record(facts);
    case "paste":
      return executePointerCommand("edit.paste");
    case "export":
      return executePointerCommand("range.bounce");
    case "remove": {
      const selection = useDawStore.getState().selection;
      if (selection?.kind === "social") return removeSocial(selection.id);
      if (selection?.kind === "comment") return removeComment(selection.id);
      if (selection?.kind === "track")
        return executePointerCommand("track.remove");
      return selection?.kind === "chapter" ||
        selection?.kind === "envelopePoint"
        ? removeMarker(selection)
        : disabled("Nothing to remove here");
    }
    case "more":
      return executePointerCommand("edit.more");
    case "inspect":
      return executePointerCommand("edit.inspect");
    case "copy":
      return executePointerCommand("edit.copy");
    case "fillRoomTone":
      return executePointerCommand("range.fillRoomTone");
    case "moveToSpeaker":
      return executePointerCommand("range.moveSpeakerLane", {
        toLaneId: arg,
      });
    case "adjustBounds":
    case "fade":
    case "moveToTrack":
      return executePointerCommand("edit.inspect", { open: true });
    case "joinType":
      return setJoinType(arg);
    case "moveTrackUp":
      return executePointerCommand("track.moveUp");
    case "moveTrackDown":
      return executePointerCommand("track.moveDown");
    case "smoothJoins":
      return smoothJoins();
    case "approve":
      return approveSocial();
    case "resolve":
      return resolveComment();
    default:
      // A mute is a More row of its own id.
      if ((id as string) === "mute") return executePointerCommand("edit.mute");
      return disabled("That action is not available here yet");
  }
}

// The bar draws what resolveBar says minus what is not wired yet, so no button is a dead end.
export const WIRED_VERBS: Readonly<Record<EditKind, readonly BarId[]>> = {
  playhead: ["split", "addChapter", "record", "paste"],
  words: [
    "hear",
    "keep",
    "split",
    "comment",
    "fixText",
    "record",
    "more",
    "inspect",
  ],
  range: ["hear", "split", "comment", "record", "export", "more", "inspect"],
  clip: ["hear", "split", "comment", "cut", "more", "inspect"],
  seam: ["hear", "joinType", "keep", "comment", "inspect"],
  suggestion: ["hearBefore", "hearAfter", "keep", "comment", "more", "inspect"],
  chapter: ["hear", "fixText", "remove", "inspect"],
  social: ["hear", "comment", "remove", "inspect"],
  comment: ["remove", "inspect"],
  track: ["remove", "more", "inspect"],
  envelope: ["inspect"],
  envelopePoint: ["hear", "remove", "inspect"],
  bleed: ["hearBefore", "hearAfter", "keep", "inspect"],
};

const WIRED_MORE: ReadonlySet<string> = new Set([
  "mute",
  "copy",
  "moveToSpeaker",
  "fillRoomTone",
  "adjustBounds",
  "seek",
  "fade",
  "moveToTrack",
  "moveTrackUp",
  "moveTrackDown",
  "smoothJoins",
]);

const WIRED_PRIMARY: ReadonlySet<string> = new Set([
  "cut",
  "shorten",
  "lower",
  "approve",
  "resolve",
]);

export function registerEditVerbCommands(): void {
  registerCommand("edit.delete", (args) => runCutSelection(args));
  registerCommand("edit.hear", () => withFacts((facts) => hearVerb(facts)));
  registerCommand("edit.hearBefore", () =>
    withFacts((facts) => hearSide(facts, "current")),
  );
  registerCommand("edit.hearAfter", () =>
    withFacts((facts) => hearSide(facts, "suggested")),
  );
  registerCommand("edit.keep", () => withFacts((facts) => keep(facts)));
  registerCommand("edit.split", () => withFacts((facts) => split(facts)));
  registerCommand("edit.mute", () => runMute());
  registerCommand("record.here", (args) => {
    const at = args.atTime;
    if (at === undefined || at === null) return recordHere();
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0)
      return disabled("atTime must be a time");
    return recordHere(at);
  });
  registerCommand("edit.inspect", (args) => {
    const s = useDawStore.getState();
    if (!s.selection) return armRangeDraft();
    // open: true is a double-click, which never closes it
    s.setInspectorOpen(
      args.open === true || !inspectorOpenFor(s.selection, s.inspectorKey),
    );
    return OK;
  });
  registerCommand("edit.more", () => {
    const s = useDawStore.getState();
    const facts = currentEditFacts(s);
    if (!facts) return disabled("No project loaded");
    if (barModelOf(facts, s).more.length === 0)
      return disabled("There are no more actions here");
    s.requestMore();
    return OK;
  });
}

async function withFacts(
  run: (facts: EditFacts) => Promise<ExecuteResult> | ExecuteResult,
): Promise<ExecuteResult> {
  const facts = currentEditFacts();
  if (!facts) return disabled("No project loaded");
  return run(facts);
}

type BarModel = {
  readonly leading: "scope" | "count" | null;
  readonly items: readonly BarItem[];
  readonly more: readonly BarItem[];
  readonly primary: (BarItem & { readonly disabledReason?: string }) | null;
};

const RESTORE_IGNORED_LABEL = "Restore ignored words";
const SPEAKER_HOST_ONLY =
  "Only the host can move a reply between speaker tracks";
const STALE_RANGE = "Selected audio changed. Select the range again.";

function wordsRestoreAvailability(
  s: DawState,
): { reason: string | null } | null {
  if (
    s.stage !== "edit" ||
    !canManageProjects(s.projectPath) ||
    s.selection?.kind !== "transcriptRange" ||
    !s.project ||
    !ignoreWouldRestore(s.project, s.selection)
  )
    return null;
  return {
    reason:
      s.project.meta.hydration?.transcript_words === false
        ? "Transcript words not loaded"
        : s.rangeBusy
          ? "Range action in progress"
          : s.joinMutationInFlight
            ? "Wait for the join edit"
            : null,
  };
}

export function barModelOf(facts: EditFacts, s: DawState): BarModel {
  const resolved = resolveBar(facts);
  const wired = WIRED_VERBS[facts.kind];
  const project = s.project;
  const rangeLike = facts.kind === "words" || facts.kind === "range";
  const resolution =
    project && rangeLike
      ? resolveSelectionRange(project, s.selection)
      : { targets: [], reason: null };
  const target =
    resolution.targets.length === 1 ? resolution.targets[0]! : null;
  const descriptors =
    project && rangeLike ? rangeActionDescriptors(s, target) : [];
  const descriptor = (action: string) =>
    descriptors.find((d) => d.action === action);
  const readOnly = facts.role === "readOnly";

  const items: BarItem[] = resolved.bar
    .filter((id) => readOnly || wired.includes(id))
    .filter(
      (id) =>
        id !== "fixText" ||
        facts.kind === "chapter" ||
        oneWordOf(s.selection) !== null,
    )
    .filter(
      (id) =>
        id !== "record" || !rangeLike || replaceableSpan(facts.span, project),
    )
    .map(
      (id) => (id === "joinType" ? joinTypeItem(s) : { id }) as BarItem | null,
    )
    .filter((item): item is BarItem => item !== null)
    .map((item): BarItem => {
      const { id } = item;
      const guestMix =
        id === "hear" && descriptor("play")?.label === PLAY_FULL_MIX_LABEL;
      if (guestMix) return { id, label: PLAY_FULL_MIX_LABEL };
      if (
        id === "comment" &&
        s.guestMode &&
        !hasShareCapability(s.shareCapabilities, "comment")
      )
        return { id, disabledReason: "This share cannot add comments" };
      if (
        id === "keep" &&
        facts.kind === "seam" &&
        !canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities)
      )
        return { id, disabledReason: EDITING_OFF_REASON };
      if (id === "keep" && facts.kind === "seam") {
        const seam = currentSeam();
        const plan = seam?.kind === "cut" ? keepPlan(seam) : null;
        return plan?.kind === "disabled"
          ? { id, disabledReason: plan.reason }
          : item;
      }
      if (id === "keep" && facts.kind === "bleed") {
        const reason = bleedKeepReason();
        return reason ? { id, disabledReason: reason } : item;
      }
      if (id === "record")
        return { id, label: rangeLike ? "Re-record" : "Record here" };
      return item;
    });

  const more: BarItem[] = [];
  for (const id of resolved.more) {
    if (!WIRED_MORE.has(id)) continue;
    if (id === "mute") {
      if (facts.kind === "track") continue;
      if (facts.kind === "clip" && selectedClipIdsOf(s.selection).length !== 1)
        continue;
      const d = descriptor("mute");
      const restore =
        facts.kind === "words" ? wordsRestoreAvailability(s) : null;
      const label = restore
        ? RESTORE_IGNORED_LABEL
        : d && d.label !== "Mute"
          ? d.label
          : null;
      const reason = restore ? restore.reason : d?.reason;
      more.push({
        id,
        ...(label ? { label } : {}),
        ...(reason ? { disabledReason: reason } : {}),
      });
    } else if (id === "moveTrackUp" || id === "moveTrackDown") {
      const up = id === "moveTrackUp";
      const gate = evaluateWhen(
        COMMANDS[up ? "track.moveUp" : "track.moveDown"].when,
        buildCommandContext(),
      );
      const reason = gate.ok
        ? null
        : gate.reason === "Already at top"
          ? "This track is already first."
          : gate.reason === "Already at bottom"
            ? "This track is already last."
            : gate.reason;
      more.push(reason ? { id, disabledReason: reason } : { id });
    } else if (id === "smoothJoins") {
      const reason = !canApplyPass12(
        s.projectPath,
        s.guestMode,
        s.shareCapabilities,
      )
        ? EDITING_OFF_REASON
        : facts.count > 1
          ? SMOOTH_ONE_TRACK
          : null;
      more.push(reason ? { id, disabledReason: reason } : { id });
    } else if (id === "fillRoomTone") {
      const reason = descriptor("fillRoomTone")?.reason;
      more.push(reason ? { id, disabledReason: reason } : { id });
    } else if (id === "moveToSpeaker") {
      const move = project ? speakerLaneMoveTarget(project, target) : null;
      if (!move || !project) continue;
      const reason =
        target && !rangeIsCurrent(project, target)
          ? STALE_RANGE
          : !canManageProjects(s.projectPath)
            ? SPEAKER_HOST_ONLY
            : s.rangeBusy || s.joinMutationInFlight
              ? BUSY_REASON
              : null;
      for (const lane of siblingSplitLanes(project.tracks, move.fromLaneId)) {
        more.push({
          id,
          arg: lane.id,
          label: `Move to ${lane.label || lane.id}`,
          ...(reason ? { disabledReason: reason } : {}),
        });
      }
    } else {
      more.push({ id });
    }
  }
  const at = items.findIndex((item) => item.id === "more");
  if (!more.length && at >= 0) items.splice(at, 1);

  let primary: BarModel["primary"] = null;
  const id = resolved.primary;
  if (id && WIRED_PRIMARY.has(id)) {
    const cut = rangeLike ? descriptor("cut") : undefined;
    const reason =
      cut?.reason ??
      (facts.kind === "suggestion" &&
      !canReviewPendingEdit(s.projectPath, s.shareCapabilities)
        ? "This link cannot decide suggestions"
        : facts.kind === "comment" && !canManageProjects(s.projectPath)
          ? "Only the host can resolve a comment"
          : undefined);
    primary = {
      id,
      ...(cut && cut.label !== "Cut" ? { label: cut.label } : {}),
      ...(reason ? { disabledReason: reason } : {}),
    };
  }
  return { leading: resolved.leading, items, more, primary };
}
