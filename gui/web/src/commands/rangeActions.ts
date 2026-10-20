import { replyHistoryHead, submitDocumentCommand } from "../api/documentEdits";
import { hostFetch } from "../api/documentTransport";
import { apiSend } from "../api/http";
import { commentDraftFromRange } from "../comments/commentAnchor";
import { setClipboard } from "../edit/clipboard";
import { rangeIsCurrent, resolveSelectionRange } from "../edit/rangeSelection";
import { extractClipsInRange } from "../edit/selectionClipboard";
import {
  hasShareCapability,
  isShareProjectKey,
  rangeEditMode,
} from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { DawState } from "../state/types";
import { oneWordOf } from "../transcript/rangeSelect";
import type { ExactRangeTarget } from "../types/project";
import { errorMessage, readApiError } from "../utils/apiError";
import { staleRenderBreakdown } from "../utils/staleRender";
import { openCommentDraft } from "./comments";
import { registerCommand } from "./execute";
import type { ExecuteResult } from "./types";

export type RangeAction = "play" | "cut" | "mute" | "comment" | "bounce";
export const RANGE_ACTIONS: RangeAction[] = [
  "play",
  "cut",
  "mute",
  "comment",
  "bounce",
];
export type RangeDescriptor = {
  action: RangeAction;
  commandId: string;
  label: string;
  reason: string | null;
};

export type RangeActionContext = Pick<
  DawState,
  | "project"
  | "projectPath"
  | "guestMode"
  | "shareCapabilities"
  | "rangeBusy"
  | "joinMutationInFlight"
  | "selection"
  | "transcriptCorrecting"
>;

function correctingWordReason(
  state: Pick<RangeActionContext, "selection" | "transcriptCorrecting">,
  action: RangeAction,
): string | null {
  if (!state.transcriptCorrecting || oneWordOf(state.selection) === null)
    return null;
  return action === "cut"
    ? "Use Select mode for media cut (Correct is ASR-only)"
    : "Use Select mode for range actions (Correct is ASR-only)";
}

export function rangeActionDescriptors(
  state: RangeActionContext,
  target: ExactRangeTarget | null,
): RangeDescriptor[] {
  const guest =
    isShareProjectKey(state.projectPath) || state.guestMode !== null;
  const mode = rangeEditMode(state.projectPath, state.shareCapabilities);
  const base = !target
    ? "Choose a range"
    : !state.project
      ? "Open a project"
      : state.rangeBusy
        ? "Range action in progress"
        : state.joinMutationInFlight
          ? "Wait for the join edit"
          : !rangeIsCurrent(state.project, target)
            ? "Selected audio changed. Select the range again."
            : null;
  return RANGE_ACTIONS.map((action) => {
    let reason = correctingWordReason(state, action) ?? base;
    if (!reason && (action === "cut" || action === "mute")) {
      if (mode === "none") reason = "This share cannot suggest edits";
      else if (!target?.clips.length) reason = "No audible media in this range";
    }
    if (!reason && action === "bounce" && guest)
      reason = "Only the host can export selected tracks";
    if (
      !reason &&
      action === "play" &&
      guest &&
      !hasShareCapability(state.shareCapabilities, "play")
    )
      reason = "This share cannot play audio";
    if (
      !reason &&
      action === "play" &&
      guest &&
      staleRenderBreakdown(state.project).stale
    )
      reason =
        "Mix out of date. Ask the host to Refresh before playing this range.";
    if (
      !reason &&
      action === "comment" &&
      guest &&
      !hasShareCapability(state.shareCapabilities, "comment")
    )
      reason = "This share cannot add comments";
    const label =
      action === "cut"
        ? mode === "edit"
          ? "Cut"
          : "Suggest cut"
        : action === "mute"
          ? mode === "edit"
            ? "Mute"
            : "Suggest mute"
          : action === "play"
            ? guest
              ? "Play full mix"
              : "Play"
            : action === "comment"
              ? "Comment"
              : "Bounce";
    return { action, commandId: `range.${action}`, label, reason };
  });
}

let previewUrl: string | null = null;

export async function runRangeAction(
  action: RangeAction,
): Promise<ExecuteResult> {
  const state = useDawStore.getState();
  const correcting = correctingWordReason(state, action);
  if (correcting) return { status: "disabled", reason: correcting };
  const resolved = state.project
    ? resolveSelectionRange(state.project, state.selection)
    : { targets: [], reason: "Open a project" };
  const target = resolved.targets.length === 1 ? resolved.targets[0]! : null;
  const descriptor = rangeActionDescriptors(state, target).find(
    (d) => d.action === action,
  )!;
  if (descriptor.reason || !target || !state.project)
    return {
      status: "disabled",
      reason:
        descriptor.reason ?? resolved.reason ?? "Choose the audible occurrence",
    };
  if (action === "comment") {
    openCommentDraft(commentDraftFromRange(target));
    return { status: "ok" };
  }
  if (action === "bounce") {
    state.setBounceRangeTarget(structuredClone(target));
    state.setBounceDialogOpen(true);
    return { status: "ok" };
  }
  state.setRangeBusy(true);
  const epoch = state.projectEpoch;
  const selection = state.selection;
  try {
    if (action === "cut" || action === "mute") {
      const result = await submitDocumentCommand(
        state.projectPath,
        "EditSelectedRange",
        { action, target },
      );
      const live = useDawStore.getState();
      if (live.projectEpoch !== epoch) return { status: "ok" };
      const applies =
        rangeEditMode(state.projectPath, state.shareCapabilities) === "edit";
      if (action === "cut" && applies && result.type === "Applied") {
        const start = target.intervals[0]!.start,
          end = target.intervals.at(-1)!.end;
        setClipboard({
          mode: "cut",
          timelineStart: start,
          timelineEnd: end,
          trackIds: target.track_ids,
          extracts: target.intervals.flatMap((r) =>
            extractClipsInRange(
              state.project!,
              r.start,
              r.end,
              target.track_ids,
            ).map((c) => ({
              ...c,
              relative_timeline_start:
                c.relative_timeline_start + r.start - start,
            })),
          ),
        });
      }
      if (result.queued === true)
        live.announceStatus("Range suggestion queued. Reconnect to send it.");
      else {
        if (live.selection === selection) live.setSelection(null);
        live.announceStatus(
          applies
            ? `Range ${action} applied. Use Undo to restore it.`
            : "Range suggestion sent for host review",
          applies ? { undo: replyHistoryHead(result) } : {},
        );
      }
      return { status: "ok" };
    }
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, action }),
    };
    const response = isShareProjectKey(state.projectPath)
      ? await apiSend(state.projectPath, { guest: "/daw/range-audio" }, init)
      : await hostFetch(
          `/api/range-audio?path=${encodeURIComponent(state.projectPath)}`,
          init,
        );
    if (!response.ok) throw new Error(await readApiError(response));
    const blob = await response.blob();
    const live = useDawStore.getState();
    if (
      live.projectEpoch !== epoch ||
      live.selection !== selection ||
      !live.project ||
      !rangeIsCurrent(live.project, target)
    )
      return {
        status: "disabled",
        reason: "Selection changed while audio was prepared",
      };
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    live.beginSourcePreview({
      ownerId: "selected-range",
      media: { kind: "rendered", url: previewUrl },
      startSec: 0,
      endSec: target.intervals.at(-1)!.end - target.intervals[0]!.start,
    });
    return { status: "ok" };
  } catch (error) {
    const reason = errorMessage(error);
    if (useDawStore.getState().projectEpoch === epoch)
      useDawStore.getState().announceStatus(reason);
    return { status: "disabled", reason };
  } finally {
    if (useDawStore.getState().projectEpoch === epoch)
      useDawStore.getState().setRangeBusy(false);
  }
}

export function registerRangeCommands(): void {
  for (const action of RANGE_ACTIONS)
    registerCommand(`range.${action}`, () => runRangeAction(action));
  registerCommand("range.arm", () => {
    const s = useDawStore.getState();
    if (!s.project || s.rangeBusy || s.joinMutationInFlight)
      return {
        status: "disabled",
        reason: "Open a project and wait for the current edit",
      };
    s.setCommentMode(false);
    s.setToolMode("select");
    s.setRangeArmed(!s.rangeArmed);
    return { status: "ok" };
  });
}
