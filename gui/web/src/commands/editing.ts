import {
  deleteClips,
  duplicateSegment,
  pasteSegment,
  rippleDeleteClips,
  rippleDeleteRange,
  splitAtTime,
} from "../api";
import { currentDocumentSeq } from "../document/cursor";
import { revertOptimisticIfUnchanged } from "../document/optimisticRevert";
import { patchClipsMove } from "../document/projectPatch";
import { getClipboard, setClipboard } from "../edit/clipboard";
import { payloadFromSelection } from "../edit/selectionClipboard";
import { canApplyPass12, canSuggestStructuralOnProject } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { errorMessage } from "../utils/apiError";
import { bladeTrackIds } from "../utils/bladeTracks";
import type { CommandContext } from "./context";
import { registerCommand } from "./execute";
import { resolveTrackId } from "./targets";
import { enqueueTrackMutate } from "./trackMutation";
import type { ExecuteResult } from "./types";

type BladeRunner = {
  requestCut: (atTime: number) => void | Promise<void>;
  confirmPending: () => void | Promise<void>;
  cancelPending: () => void;
};

let bladeRunner: BladeRunner | null = null;
/** Injected from useBladeCut so execute stays hook-free. */
export function setBladeCommandRunner(runner: BladeRunner | null): void {
  bladeRunner = runner;
}

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
  _ctx: CommandContext,
  atTime: number,
): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (!s.project || !canSuggestStructuralFor(s)) {
    return { status: "disabled", reason: "Structural edits not allowed" };
  }
  const dialogueIds = (s.project.tracks ?? [])
    .filter((t) => t.role === "dialogue")
    .map((t) => t.id);
  const tids = bladeTrackIds(s.selectedTrackIds, dialogueIds);
  await splitAtTime(s.projectPath, atTime, tids);
  s.setBladeConfirmSec(null);
  return { status: "ok" };
}

function resolveClipId(args: Record<string, unknown>): string | null {
  if (typeof args.clipId === "string" && args.clipId) {
    return args.clipId;
  }
  const s = useDawStore.getState();
  if (s.selection?.kind === "clip") {
    return s.selection.id;
  }
  return null;
}

async function runDeleteClip(
  clipId: string,
  ripple: boolean,
): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (!canSuggestStructuralFor(s)) {
    return { status: "disabled", reason: "Structural edits not allowed" };
  }
  try {
    if (ripple) {
      await rippleDeleteClips(s.projectPath, [clipId]);
    } else {
      await deleteClips(s.projectPath, [clipId]);
    }
    const store = useDawStore.getState();
    store.setSelection(null);
    store.announceStatus(ripple ? "Ripple deleted clip" : "Deleted clip");
    return { status: "ok" };
  } catch (e) {
    const msg = errorMessage(e);
    useDawStore.getState().announceStatus(`Delete failed: ${msg}`);
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
    if (bladeRunner) {
      await bladeRunner.requestCut(atTime);
      return { status: "ok" };
    }
    const s = useDawStore.getState();
    if (s.shellBreakpoint === "phone" || s.shellBreakpoint === "tablet") {
      s.setBladeConfirmSec(atTime);
      return { status: "ok" };
    }
    return runSplitAt(ctx, atTime);
  });

  registerCommand("edit.bladeCut.confirm", async (_args, ctx) => {
    if (bladeRunner) {
      await bladeRunner.confirmPending();
      return { status: "ok" };
    }
    if (ctx.bladeConfirmSec == null) {
      return { status: "disabled", reason: "No pending blade cut" };
    }
    return runSplitAt(ctx, ctx.bladeConfirmSec);
  });

  registerCommand("edit.bladeCut.cancel", () => {
    if (bladeRunner) {
      bladeRunner.cancelPending();
      return { status: "ok" };
    }
    useDawStore.getState().setBladeConfirmSec(null);
    return { status: "ok" };
  });

  registerCommand("edit.delete", async (args) => {
    const clipId = resolveClipId(args);
    if (!clipId) {
      return { status: "disabled", reason: "No clip selected" };
    }
    return runDeleteClip(clipId, false);
  });

  registerCommand("edit.clearSelection", () => {
    useDawStore.getState().setSelection(null);
    return { status: "ok" };
  });

  registerCommand("edit.rippleDelete", async (args) => {
    const clipId = resolveClipId(args);
    if (!clipId) {
      return { status: "disabled", reason: "No clip selected" };
    }
    return runDeleteClip(clipId, true);
  });

  registerCommand("track.selectAll", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.setSelectedTrackIds(s.project.tracks.map((t) => t.id));
    return { status: "ok" };
  });

  registerCommand("track.deselectAll", () => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    s.setSelectedTrackIds([]);
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
    useDawStore.getState().toggleSolo(trackId);
    return { status: "ok" };
  });
}

export function registerClipboardCommands(): void {
  registerCommand("edit.copy", (_args) => {
    const s = useDawStore.getState();
    if (!s.project) {
      return { status: "disabled", reason: "No project" };
    }
    const payload = payloadFromSelection(s.project, s.selection, "copy");
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
    if (s.selection?.kind === "transcriptWord") {
      return {
        status: "disabled",
        reason: "Use Select mode for media cut (Correct is ASR-only)",
      };
    }
    const payload = payloadFromSelection(s.project, s.selection, "cut");
    if (!payload) {
      return { status: "disabled", reason: "Nothing to cut" };
    }
    setClipboard(payload);
    if (payload.plainText && typeof navigator !== "undefined") {
      void navigator.clipboard?.writeText?.(payload.plainText).catch(() => {});
    }
    try {
      if (s.selection?.kind === "clip") {
        await rippleDeleteClips(s.projectPath, [s.selection.id]);
      } else {
        await rippleDeleteRange(
          s.projectPath,
          payload.timelineStart,
          payload.timelineEnd,
        );
      }
      const store = useDawStore.getState();
      store.setSelection(null);
      store.announceStatus("Cut to clipboard");
      return { status: "ok" };
    } catch (e) {
      const msg = errorMessage(e);
      useDawStore.getState().announceStatus(`Cut failed: ${msg}`);
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
      if (clip.mode === "cut" || clip.extracts.length > 0) {
        await pasteSegment(
          s.projectPath,
          s.playheadSec,
          duration,
          clip.extracts as unknown as Array<Record<string, unknown>>,
        );
      } else {
        await duplicateSegment(
          s.projectPath,
          clip.timelineStart,
          clip.timelineEnd,
          s.playheadSec,
        );
      }
      useDawStore.getState().announceStatus("Pasted at playhead (same track)");
      return { status: "ok" };
    } catch (e) {
      const msg = errorMessage(e);
      useDawStore.getState().announceStatus(`Paste failed: ${msg}`);
      return { status: "disabled", reason: msg };
    }
  });
}

export function registerClipMoveCommands(): void {
  registerCommand("edit.trimClipEdge", () => {
    return {
      status: "disabled",
      reason: "Use the clip trim handles on the timeline",
    };
  });

  registerCommand("edit.rollClipJoin", () => {
    return {
      status: "disabled",
      reason: "Use the join diamond or transcript boundary glyph",
    };
  });

  registerCommand("edit.setClipFade", () => {
    return {
      status: "disabled",
      reason: "Use the clip fade handles on the timeline",
    };
  });

  registerCommand("edit.moveClips", async (args) => {
    return enqueueTrackMutate(async () => {
      const s = useDawStore.getState();
      if (!canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities)) {
        return { status: "disabled", reason: "Edits not allowed" };
      }
      if (!s.project) {
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
      const previous = s.project;
      const seqAtStart = currentDocumentSeq();
      s.setProject(patchClipsMove(previous, clips));
      const sel = s.selection;
      if (sel?.kind === "clip") {
        const moved = clips.find((c) => c.clip_id === sel.id);
        if (moved) {
          s.setSelection({ ...sel, trackId: moved.track_id });
        }
      }
      try {
        const { moveClips } = await import("../api");
        await moveClips(s.projectPath, clips);
        useDawStore.getState().announceStatus("Moved clips");
        return { status: "ok" };
      } catch (e) {
        revertOptimisticIfUnchanged(previous, seqAtStart);
        const msg = errorMessage(e);
        useDawStore.getState().announceStatus(`Move failed: ${msg}`);
        return { status: "disabled", reason: msg };
      }
    });
  });
}
