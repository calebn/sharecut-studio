/**
 * The Action bar's verbs, run (#2294 W1b). `runEditVerb` maps a bar id to the
 * command that does it, through `executePointerCommand`, so a refusal reaches
 * the live region in plain words. The key commands (`edit.hear`, `edit.keep`,
 * `edit.split`, `edit.delete`, ...) are the same functions on the selection the
 * store holds, so the bar and the keyboard cannot disagree.
 */
import {
  applySuggestedActions,
  approveEdits,
  deleteChapter,
  rejectEdits,
  setEnvelope,
} from "../api";
import { playPendingPreview } from "../audio/pendingPreview";
import { getClipboard } from "../edit/clipboard";
import {
  type EditFacts,
  type EditKind,
  type EditRole,
  editFacts,
} from "../edit/editSelection";
import {
  makeRangeTarget,
  rangeIsCurrent,
  resolveSelectionRange,
} from "../edit/rangeSelection";
import {
  canEditEnvelopes,
  canManageProjects,
  canReviewPendingEdit,
  hasShareCapability,
  isShareProjectKey,
  rangeEditMode,
} from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { inspectorOpenFor, selectedClipIdsOf } from "../state/selection";
import { transportAvailability } from "../state/transportAvailability";
import type { BarItem } from "../system/actionBarSlots";
import { type BarId, resolveBar } from "../system/editActionSets";
import { BUSY_REASON } from "../ui/disabledReason";
import { siblingSplitLanes, speakerLaneMoveTarget } from "../utils/speakerSplit";
import type { ProjectView, Selection } from "../types/project";
import { errorMessage } from "../utils/apiError";
import { findVolumeEnvelope } from "../utils/envelopes";
import { oneWordOf } from "../utils/rangeSelect";
import { playTimelineRange } from "../utils/playRange";
import {
  capturePendingReview,
  finishPendingReview,
} from "../utils/pendingReviewPass";
import { staleRenderBreakdown } from "../utils/staleRender";
import { runDeleteClips } from "./editing";
import { registerCommand } from "./execute";
import { executePointerCommand } from "./pointer";
import {
  PLAY_DENIED_REASON,
  PLAY_STALE_REASON,
  rangeActionDescriptors,
  runRangeAction,
} from "./rangeActions";
import { seekTransport } from "./seek";
import { requestInlineEdit } from "./transcriptWord";
import type { ExecuteResult } from "./types";

/** A More row that stands for one target, such as Move to Ben. */
export type VerbArg = string | undefined;

const disabled = (reason: string): ExecuteResult => ({
  status: "disabled",
  reason,
});
const OK: ExecuteResult = { status: "ok" };

type DawState = ReturnType<typeof useDawStore.getState>;

export function editRoleOf(
  s: Pick<DawState, "projectPath" | "shareCapabilities">,
): EditRole {
  if (canManageProjects(s.projectPath)) return "host";
  return rangeEditMode(s.projectPath, s.shareCapabilities) === "none"
    ? "readOnly"
    : "editor";
}

/** The facts of the selection the store holds now, or null before a project opens. */
export function currentEditFacts(
  s: DawState = useDawStore.getState(),
): EditFacts | null {
  if (!s.project) return null;
  return editFacts(s.selection, s.project, {
    role: editRoleOf(s),
    clipboardHasAudio: getClipboard() != null,
  });
}

/** Why this share cannot play, or null. */
function playGate(s: DawState): string | null {
  const reason = transportAvailability(s).togglePlay;
  if (reason !== undefined) return reason;
  const guest = isShareProjectKey(s.projectPath) || s.guestMode !== null;
  if (guest && !hasShareCapability(s.shareCapabilities, "play"))
    return PLAY_DENIED_REASON;
  if (guest && staleRenderBreakdown(s.project).stale) return PLAY_STALE_REASON;
  return null;
}

function playSpan(start: number, end: number, padSec: number): ExecuteResult {
  const s = useDawStore.getState();
  const reason = playGate(s);
  if (reason) return disabled(reason);
  playTimelineRange({
    start,
    end,
    padSec,
    beginAudition: s.beginAudition,
    setPlayheadSec: (sec) => void seekTransport(sec),
    setPlayUntilSec: s.setPlayUntilSec,
    setIsPlaying: s.setIsPlaying,
  });
  return OK;
}

/** Seconds of context either side of a seam, a marker or a clip edge. */
const HEAR_PAD_SEC = 1;
const MARKER_HEAR_SEC = 3;

async function hearVerb(facts: EditFacts): Promise<ExecuteResult> {
  switch (facts.kind) {
    case "words":
    case "range":
      return executePointerCommand("range.play");
    case "clip":
      return facts.span
        ? playSpan(facts.span.start, facts.span.end, 0)
        : disabled("Select a clip to hear it");
    case "seam":
    case "appliedEdge":
      return facts.span
        ? playSpan(facts.span.start, facts.span.end, HEAR_PAD_SEC)
        : disabled("This edit has no place on the timeline to hear");
    case "chapter":
    case "social":
    case "comment":
      return facts.span
        ? playSpan(facts.span.start, facts.span.start + MARKER_HEAR_SEC, 0)
        : disabled("Nothing to hear here");
    default:
      return disabled("Nothing to hear here");
  }
}

async function hearSide(
  facts: EditFacts,
  mode: "current" | "suggested",
): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (facts.kind !== "suggestion" || s.selection?.kind !== "pending")
    return disabled("Select a suggestion to hear it");
  const outcome = await playPendingPreview(
    s.projectPath,
    s.selection.id,
    mode,
  );
  if (outcome.status === "ok") return OK;
  if (outcome.status === "superseded") return OK;
  return disabled(outcome.reason);
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
    return disabled(reason);
  }
}

async function keep(facts: EditFacts): Promise<ExecuteResult> {
  if (facts.kind === "suggestion") return decidePending("reject");
  if (facts.kind === "words" || facts.kind === "seam") {
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

/** The bar's Cut, and Backspace: one answer per kind of selection. */
export async function runCutSelection(
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
      return disabled(
        selection ? "There is nothing to cut in this selection" : "No clip selected",
      );
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
    if (!canEditEnvelopes(s.projectPath, s.guestMode, s.shareCapabilities))
      return disabled("Only the host and editors can change envelopes");
    const origin = (
      findVolumeEnvelope(s.project?.envelopes, selection.trackId)?.points ?? []
    ).map((point) => ({ ...point }));
    if (!origin.some((point) => point.id === selection.pointId))
      return disabled("That point is gone");
    const undo = await setEnvelope(
      s.projectPath,
      selection.trackId,
      origin.filter((point) => point.id !== selection.pointId),
      origin,
    );
    const live = useDawStore.getState();
    live.setSelection({ kind: "envelope", trackId: selection.trackId });
    live.announceStatus("Envelope point removed", { undo });
    return OK;
  } catch (error) {
    const reason = errorMessage(error);
    useDawStore.getState().announceStatus(reason, { tone: "error" });
    return disabled(reason);
  }
}

/** Where Split cuts: both edges of a span, or the playhead (and the tracks it cuts on). */
export function splitPlan(
  facts: EditFacts,
  selection: Selection,
  project: ProjectView,
  playheadSec: number,
  scope: readonly string[] | null,
): { atTime: number; extraAtTimes: number[]; trackIds?: string[] } | string {
  if (facts.kind === "words" || facts.kind === "range") {
    if (!facts.span) return "This selection has no place on the timeline";
    const trackIds = [...(scope ?? facts.span.trackIds)];
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
  const plan = splitPlan(
    facts,
    s.selection,
    s.project,
    s.playheadSec,
    s.rangeScopeTrackIds,
  );
  if (typeof plan === "string") return disabled(plan);
  return executePointerCommand("edit.bladeCut", plan);
}

async function comment(facts: EditFacts): Promise<ExecuteResult> {
  if (facts.kind === "words" || facts.kind === "range")
    return executePointerCommand("range.comment");
  return executePointerCommand("comment.draftAt", {});
}

async function record(facts: EditFacts): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (!canManageProjects(s.projectPath))
    return disabled("Only the host can record");
  const span = facts.span;
  const target =
    (facts.kind === "words" || facts.kind === "range") &&
    span &&
    span.end > span.start &&
    span.trackIds.length
      ? {
          kind: "replace",
          from_sec: span.start,
          to_sec: span.end,
          track_ids: [...span.trackIds],
        }
      : { kind: "insert", at_sec: s.playheadSec };
  const set = await executePointerCommand("record.setTarget", { target });
  if (set.status !== "ok") return set;
  return executePointerCommand("stage.record");
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

/** M and the More row: words ignore, a range or one clip mutes its span, anything else mutes its track. */
export async function runMute(): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  switch (s.selection?.kind) {
    case "transcriptRange":
      return executePointerCommand("transcript.ignoreWords");
    case "range":
      return executePointerCommand("range.mute");
    case "clip": {
      const target = s.project ? singleClipTarget(s.project, s.selection) : null;
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

/** Runs one Action bar verb on `facts`' selection; a refusal is announced. */
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

function announceRefusal(result: ExecuteResult): ExecuteResult {
  if (result.status === "disabled")
    useDawStore.getState().announceStatus(result.reason, { tone: "error" });
  return result;
}

async function dispatch(
  id: BarId,
  facts: EditFacts,
  arg: VerbArg,
): Promise<ExecuteResult> {
  switch (id) {
    case "hear":
      return hearVerb(facts);
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
      return executePointerCommand("edit.inspect");
    case "approve":
    case "resolve":
    default:
      // A mute is a More row of its own id.
      if ((id as string) === "mute") return executePointerCommand("edit.mute");
      return disabled("That action is not available here yet");
  }
}

/**
 * Which verbs this slice wires for each kind of selection. The bar draws what
 * `resolveBar` says minus what is not wired, so no button is a dead end; the
 * later slices (Script, Inspector contents, Seam, Marker lane) widen this table.
 */
export const WIRED_VERBS: Readonly<Record<EditKind, readonly BarId[]>> = {
  playhead: ["split", "addChapter", "record", "paste"],
  words: ["hear", "keep", "comment", "fixText", "record", "more", "inspect"],
  range: ["hear", "split", "comment", "record", "export", "more", "inspect"],
  clip: ["hear", "split", "comment", "cut", "more", "inspect"],
  seam: ["hear", "keep", "comment", "inspect"],
  appliedEdge: ["hear", "comment", "inspect"],
  suggestion: [
    "hearBefore",
    "hearAfter",
    "keep",
    "comment",
    "more",
    "inspect",
  ],
  chapter: ["hear", "remove", "inspect"],
  social: ["inspect"],
  comment: ["inspect"],
  track: ["inspect"],
  envelope: ["inspect"],
  envelopePoint: ["remove", "inspect"],
  bleed: ["inspect"],
};

/** More rows this slice wires; the others wait for their Inspector parts. */
export const WIRED_MORE: ReadonlySet<string> = new Set([
  "mute",
  "copy",
  "moveToSpeaker",
  "fillRoomTone",
  "adjustBounds",
  "fade",
  "moveToTrack",
]);

/** The primary verbs this slice wires: Cut, and a suggestion's own accept. */
export const WIRED_PRIMARY: ReadonlySet<string> = new Set([
  "cut",
  "shorten",
  "lower",
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
  registerCommand("edit.inspect", () => {
    const s = useDawStore.getState();
    if (!s.selection) return disabled("Select something to inspect");
    s.setInspectorOpen(!inspectorOpenFor(s.selection, s.inspectorKey));
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

export type BarModel = {
  readonly leading: "scope" | "count" | null;
  readonly items: readonly BarItem[];
  readonly more: readonly BarItem[];
  readonly primary: (BarItem & { readonly disabledReason?: string }) | null;
};

const SPEAKER_HOST_ONLY =
  "Only the host can move a reply between speaker tracks";
const STALE_RANGE = "Selected audio changed. Select the range again.";

/**
 * What the bar shows for `facts`: `resolveBar`'s answer narrowed to the verbs
 * this slice wires, worded and gated as `rangeActionDescriptors` words them
 * (Suggest cut, Play full mix, the stale and busy reasons).
 */
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
  const descriptors = project && rangeLike ? rangeActionDescriptors(s, target) : [];
  const descriptor = (action: string) =>
    descriptors.find((d) => d.action === action);
  const readOnly = facts.role === "readOnly";

  const items: BarItem[] = resolved.bar
    .filter((id) => readOnly || wired.includes(id))
    .filter((id) => id !== "fixText" || oneWordOf(s.selection) !== null)
    .map((id): BarItem => {
      const label = id === "hear" ? descriptor("play")?.label : undefined;
      return label ? { id, label } : { id };
    });

  const more: BarItem[] = [];
  for (const id of resolved.more) {
    if (!WIRED_MORE.has(id)) continue;
    if (id === "mute") {
      if (facts.kind === "clip" && selectedClipIdsOf(s.selection).length !== 1)
        continue;
      const d = descriptor("mute");
      more.push({
        id,
        ...(d && d.label !== "Mute" ? { label: d.label } : {}),
        ...(d?.reason ? { disabledReason: d.reason } : {}),
      });
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
        : undefined);
    primary = {
      id,
      ...(cut && cut.label !== "Cut" ? { label: cut.label } : {}),
      ...(reason ? { disabledReason: reason } : {}),
    };
  }
  return { leading: resolved.leading, items, more, primary };
}
