import {
  deleteClips,
  duplicateSegment,
  moveClips,
  pasteSegment,
  rippleDeleteClips,
  splitAtTime,
} from "../api";
import { redisplayDrafts } from "../document/applyDocumentUpdate";
import {
  documentScope,
  isCurrentDocumentScope,
} from "../document/authorityState";
import { currentDocumentSeq } from "../document/cursor";
import { revertOptimisticIfUnchanged } from "../document/optimisticRevert";
import { getClipboard, setClipboard } from "../edit/clipboard";
import { clipPlacementIsCurrent } from "../edit/clipPlacement";
import { payloadFromSelection } from "../edit/selectionClipboard";
import { canApplyPass12, canSuggestStructuralOnProject } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import {
  inspectorOpenFor,
  selectedClipIdsOf,
  selectedTrackIdsOf,
} from "../state/selection";
import {
  SOLO_OFF_ANNOUNCEMENT,
  SOLO_ON_ANNOUNCEMENT,
} from "../tracks/trackMuteCopy";
import { ApiError, errorMessage } from "../utils/apiError";
import { anySolo } from "../utils/audio";
import { bladeTrackIds, dialogueTrackIds } from "../utils/bladeTracks";
import { formatTime } from "../utils/time";
import { openCreateMenu } from "./createMenuHost";
import { registerCommand } from "./execute";
import { runFocusedClipHandle } from "./focusedClipHandle";
import { runRangeAction } from "./rangeActions";
import { resolveTrackId } from "./targets";
import { enqueueTrackMutate } from "./trackMutation";
import type { ExecuteResult } from "./types";

type DawState = ReturnType<typeof useDawStore.getState>;

function canSuggestStructuralFor(s: DawState): boolean {
  return canSuggestStructuralOnProject(
    s.projectPath,
    s.guestMode,
    s.shareCapabilities,
    s.project != null,
  );
}
async function runSplitAt(
  atTime: number,
  extraAtTimes: readonly number[],
  trackIds: readonly string[] | null,
): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (!s.project || !canSuggestStructuralFor(s)) {
    return { status: "disabled", reason: "Structural edits not allowed" };
  }
  const tids = trackIds?.length
    ? [...trackIds]
    : bladeTrackIds(
        selectedTrackIdsOf(s.selection),
        dialogueTrackIds(s.project.tracks ?? []),
      );
  try {
    const undo = await splitAtTime(
      s.projectPath,
      atTime,
      tids,
      null,
      extraAtTimes,
    );
    const where = [atTime, ...extraAtTimes].map((t) => formatTime(t));
    useDawStore
      .getState()
      .announceStatus(`Split at ${where.join(" and ")}`, { undo });
    return { status: "ok" };
  } catch (e) {
    const code = e instanceof ApiError ? e.code : undefined;
    const reason =
      code === "no_clip_at_time"
        ? "There is no clip at that time to split"
        : errorMessage(e);
    return { status: "disabled", reason };
  }
}

function resolveClipIds(args: Record<string, unknown>): string[] {
  if (typeof args.clipId === "string" && args.clipId) {
    return [args.clipId];
  }
  return [...selectedClipIdsOf(useDawStore.getState().selection)];
}

export async function runDeleteClips(
  clipIds: readonly string[],
  ripple: boolean,
): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (!clipIds.length) {
    return { status: "disabled", reason: "No clip selected" };
  }
  if (!canSuggestStructuralFor(s)) {
    return { status: "disabled", reason: "Structural edits not allowed" };
  }
  const project = s.projectEditBasis();
  const known = new Set(
    project
      ? Object.values(project.clips.tracks)
          .flat()
          .map((clip) => clip.id)
      : [],
  );
  if (!project || clipIds.some((id) => !known.has(id))) {
    return { status: "disabled", reason: "Unknown clip" };
  }
  const noun = clipIds.length === 1 ? "clip" : `${clipIds.length} clips`;
  try {
    const undo = ripple
      ? await rippleDeleteClips(s.projectPath, [...clipIds])
      : await deleteClips(s.projectPath, [...clipIds]);
    const store = useDawStore.getState();
    store.setSelection(null);
    store.announceStatus(
      ripple ? `Ripple deleted ${noun}` : `Deleted ${noun}`,
      { undo },
    );
    return { status: "ok" };
  } catch (e) {
    const msg = errorMessage(e);
    useDawStore
      .getState()
      .announceStatus(`Delete failed: ${msg}`, { tone: "error" });
    return { status: "disabled", reason: msg };
  }
}
export function registerPrimaryEditingCommands(): void {
  registerCommand("edit.bladeCut", async (args, ctx) => {
    const raw = args.atTime;
    const atTime =
      raw === undefined || raw === null ? ctx.playheadSec : Number(raw);
    if (!Number.isFinite(atTime)) {
      return { status: "disabled", reason: "atTime must be a number" };
    }
    const s = useDawStore.getState();
    if (!s.project || !canSuggestStructuralFor(s)) {
      return { status: "disabled", reason: "Structural edits not allowed" };
    }
    const extra = Array.isArray(args.extraAtTimes)
      ? args.extraAtTimes.map(Number).filter(Number.isFinite)
      : [];
    const trackIds = Array.isArray(args.trackIds)
      ? args.trackIds.filter((id): id is string => typeof id === "string")
      : null;
    return runSplitAt(atTime, extra, trackIds);
  });

  registerCommand("create.menu", () =>
    openCreateMenu()
      ? { status: "ok" }
      : { status: "disabled", reason: "No track to create on" },
  );

  registerCommand("edit.clearSelection", () => {
    const s = useDawStore.getState();
    if (inspectorOpenFor(s.selection, s.inspectorKey)) {
      s.setInspectorOpen(false);
      return { status: "ok" };
    }
    s.setSelection(null);
    return { status: "ok" };
  });

  registerCommand("edit.rippleDelete", (args) =>
    runDeleteClips(resolveClipIds(args), true),
  );

  registerCommand("track.selectAll", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.selectTracks(s.project.tracks.map((t) => t.id));
    return { status: "ok" };
  });

  registerCommand("track.deselectAll", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    if (s.selection?.kind === "track") {
      s.setSelection(null);
    }
    return { status: "ok" };
  });

  registerCommand("track.soloToggle", (args) => {
    const trackId = resolveTrackId(args);
    if (!trackId) {
      return { status: "disabled", reason: "No track selected" };
    }
    const s = useDawStore.getState();
    const wasOn = anySolo(s.soloTracks);
    s.toggleSolo(trackId);
    const on = anySolo(useDawStore.getState().soloTracks);
    if (on !== wasOn) {
      s.announceStatus(on ? SOLO_ON_ANNOUNCEMENT : SOLO_OFF_ANNOUNCEMENT);
    }
    return { status: "ok" };
  });

  registerCommand("track.clearSolo", () => {
    const s = useDawStore.getState();
    if (!anySolo(s.soloTracks)) {
      return { status: "disabled", reason: "No track is soloed" };
    }
    s.setSoloMap({});
    s.announceStatus(SOLO_OFF_ANNOUNCEMENT);
    return { status: "ok" };
  });
}

export function registerClipboardCommands(): void {
  registerCommand("edit.copy", (_args) => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    const project = s.projectEditBasis();
    const payload = project
      ? payloadFromSelection(project, s.selection, "copy")
      : null;
    if (!payload) {
      return { status: "disabled", reason: "Nothing to copy" };
    }
    setClipboard(payload);
    if (payload.plainText && typeof navigator !== "undefined") {
      void navigator.clipboard?.writeText?.(payload.plainText).catch(() => {});
    }
    s.announceStatus(
      `Copied ${(payload.timelineEnd - payload.timelineStart).toFixed(2)}s`,
    );
    return { status: "ok" };
  });

  registerCommand("edit.cut", async (args) => {
    const held = useDawStore.getState();
    if (
      held.selection?.kind === "range" ||
      held.selection?.kind === "transcriptRange"
    )
      return runRangeAction("cut");
    const s = useDawStore.getState();
    if (
      "clipId" in args &&
      (typeof args.clipId !== "string" ||
        s.selection?.kind !== "clip" ||
        s.selection.id !== args.clipId)
    ) {
      return { status: "disabled", reason: "Selected clip changed" };
    }
    if (
      !canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities) ||
      !s.project
    ) {
      return { status: "disabled", reason: "Cut not allowed" };
    }
    const project = s.projectEditBasis();
    const payload =
      project && s.selection?.kind === "clip"
        ? payloadFromSelection(project, s.selection, "cut")
        : null;
    if (s.selection?.kind !== "clip" || !payload) {
      return { status: "disabled", reason: "Nothing to cut" };
    }
    setClipboard(payload);
    if (payload.plainText && typeof navigator !== "undefined") {
      void navigator.clipboard?.writeText?.(payload.plainText).catch(() => {});
    }
    try {
      const undo = await rippleDeleteClips(s.projectPath, [s.selection.id]);
      const store = useDawStore.getState();
      store.setSelection(null);
      store.announceStatus("Cut to clipboard", { undo });
      return { status: "ok" };
    } catch (e) {
      const msg = errorMessage(e);
      useDawStore
        .getState()
        .announceStatus(`Cut failed: ${msg}`, { tone: "error" });
      return { status: "disabled", reason: msg };
    }
  });

  registerCommand("edit.paste", async (_args) => {
    const s = useDawStore.getState();
    if (
      !canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities) ||
      !s.project
    ) {
      return { status: "disabled", reason: "Paste not allowed" };
    }
    const clip = getClipboard();
    if (!clip) {
      return { status: "disabled", reason: "Clipboard empty" };
    }
    const duration = clip.timelineEnd - clip.timelineStart;
    try {
      const undo =
        clip.mode === "cut" || clip.extracts.length > 0
          ? await pasteSegment(
              s.projectPath,
              s.playheadSec,
              duration,
              clip.extracts as unknown as Array<Record<string, unknown>>,
            )
          : await duplicateSegment(
              s.projectPath,
              clip.timelineStart,
              clip.timelineEnd,
              s.playheadSec,
            );
      useDawStore
        .getState()
        .announceStatus("Pasted at playhead (same track)", { undo });
      return { status: "ok" };
    } catch (e) {
      const msg = errorMessage(e);
      useDawStore
        .getState()
        .announceStatus(`Paste failed: ${msg}`, { tone: "error" });
      return { status: "disabled", reason: msg };
    }
  });
}

export function registerClipMoveCommands(): void {
  registerCommand("edit.trimClipEdge", (args, ctx) => {
    if (!ctx.canApplyPass12)
      return { status: "disabled", reason: "Edits not allowed" };
    return runFocusedClipHandle("trim", args);
  });

  registerCommand("edit.rollClipJoin", () => {
    return {
      status: "disabled",
      reason: "Use the roll seam line or transcript boundary glyph",
    };
  });

  registerCommand("edit.setClipFade", (args, ctx) => {
    if (!ctx.canApplyPass12)
      return { status: "disabled", reason: "Edits not allowed" };
    return runFocusedClipHandle("fade", args);
  });

  registerCommand("edit.setClipJoin", () => {
    return {
      status: "disabled",
      reason:
        "Use the join glyph on the timeline or the Join control in the clip inspector",
    };
  });

  registerCommand("edit.moveClips", async (args) => {
    const scope = documentScope();
    return enqueueTrackMutate(async () => {
      if (!isCurrentDocumentScope(scope))
        return { status: "disabled", reason: "The episode changed" };
      const s = useDawStore.getState();
      if (
        args.placementToken !== undefined &&
        (typeof args.placementToken !== "number" ||
          !clipPlacementIsCurrent(args.placementToken))
      ) {
        return {
          status: "disabled",
          reason: "The clip placement changed. Reopen Move clip.",
        };
      }
      if (s.joinMutationInFlight) {
        return {
          status: "disabled",
          reason: "Wait for the join change to finish",
        };
      }
      if (!canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities)) {
        return { status: "disabled", reason: "Edits not allowed" };
      }
      const previous = s.projectEditBasis();
      if (!previous) {
        return { status: "disabled", reason: "No project" };
      }
      const raw = args.clips;
      if (!Array.isArray(raw) || raw.length === 0) {
        return { status: "disabled", reason: "clips must be a non-empty list" };
      }
      const clips: Array<{
        clip_id: string;
        timeline_start: number;
        track_id: string;
      }> = [];
      for (const item of raw) {
        if (!item || typeof item !== "object") {
          return {
            status: "disabled",
            reason: "each clip move must be an object",
          };
        }
        const rec = item as Record<string, unknown>;
        if (
          typeof rec.clip_id !== "string" ||
          typeof rec.track_id !== "string" ||
          typeof rec.timeline_start !== "number" ||
          !Number.isFinite(rec.timeline_start)
        ) {
          return { status: "disabled", reason: "invalid clip move" };
        }
        clips.push({
          clip_id: rec.clip_id,
          timeline_start: rec.timeline_start,
          track_id: rec.track_id,
        });
      }
      const existing = new Set(
        Object.values(previous.clips.tracks)
          .flat()
          .map((clip) => clip.id),
      );
      if (
        clips.some(
          (clip) =>
            !existing.has(clip.clip_id) ||
            !previous.tracks.some((track) => track.id === clip.track_id),
        )
      ) {
        return { status: "disabled", reason: "Unknown clip or track" };
      }
      const seqAtStart = currentDocumentSeq();
      // The command begins its draft before it first awaits, so showing the
      // drafts now shows the move at once.
      const sending = moveClips(s.projectPath, clips);
      redisplayDrafts();
      const optimistic = useDawStore.getState().project;
      const sel = s.selection;
      if (sel?.kind === "clip") {
        const moved = clips.find((c) => c.clip_id === sel.id);
        if (moved) {
          s.setSelection({ ...sel, trackId: moved.track_id });
        }
      }
      try {
        const undo = await sending;
        if (!isCurrentDocumentScope(scope))
          return { status: "disabled", reason: "The episode changed" };
        useDawStore.getState().announceStatus("Moved clips", { undo });
        return { status: "ok" };
      } catch (e) {
        if (!isCurrentDocumentScope(scope))
          return { status: "disabled", reason: "The episode changed" };
        if (optimistic)
          revertOptimisticIfUnchanged(
            previous,
            seqAtStart,
            s.projectPath,
            optimistic,
          );
        const msg = errorMessage(e);
        useDawStore
          .getState()
          .announceStatus(`Move failed: ${msg}`, { tone: "error" });
        return { status: "disabled", reason: msg };
      }
    });
  });
}
