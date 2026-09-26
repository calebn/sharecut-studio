import { COMMANDS } from "../commands/catalog";
import { type CommandContext, evaluateWhen } from "../commands/context";
import type { ProjectView, Selection } from "../types/project";

export type RelatedCommandDescriptor = {
  /** Related actions always honor the command catalog's availability gate. */
  respectWhen: true;
} & (
  | { commandId: "edit.copy"; args: Record<string, never> }
  | { commandId: "edit.cut"; args: { clipId: string } }
  | {
      commandId: "track.moveUp" | "track.moveDown";
      args: { trackId: string };
    }
);

const COPY_SELECTION: RelatedCommandDescriptor = {
  commandId: "edit.copy",
  args: {},
  respectWhen: true,
};

/**
 * Secondary actions for the mobile selection-sheet Related zone.
 *
 * Keep this deliberately small: inspectors own their primary mutations, and
 * every entry here must be a live command-bus action for this exact selection.
 */
export function relatedCommandsFor(
  selection: Selection | null,
): readonly RelatedCommandDescriptor[] {
  switch (selection?.kind) {
    case "clip":
    case "transcriptWord":
      return [COPY_SELECTION];
    default:
      return [];
  }
}

/** Only expose actions for the selection currently owned by the command bus. */
function isLiveSelection(selection: Selection, live: Selection): boolean {
  if (selection?.kind !== live?.kind) {
    return false;
  }
  if (selection?.kind === "clip" && live?.kind === "clip") {
    return selection.id === live.id && selection.trackId === live.trackId;
  }
  if (selection?.kind === "track" && live?.kind === "track") {
    return selection.trackId === live.trackId;
  }
  return false;
}

/** Selection-specific overflow; inspector actions and Related Copy stay separate. */
export function moreCommandsFor(
  selection: Selection,
  liveSelection: Selection,
  project: ProjectView | null,
  context: CommandContext,
): readonly RelatedCommandDescriptor[] {
  if (!project || !isLiveSelection(selection, liveSelection)) {
    return [];
  }
  if (selection?.kind === "clip") {
    if (
      !project.clips.tracks[selection.trackId]?.some(
        (clip) => clip.id === selection.id,
      ) ||
      !evaluateWhen(COMMANDS["edit.cut"].when, context).ok
    ) {
      return [];
    }
    return [
      {
        commandId: "edit.cut",
        args: { clipId: selection.id },
        respectWhen: true,
      },
    ];
  }
  if (selection?.kind === "track") {
    if (!project.tracks.some((track) => track.id === selection.trackId)) {
      return [];
    }
    return (["track.moveUp", "track.moveDown"] as const)
      .filter((commandId) => evaluateWhen(COMMANDS[commandId].when, context).ok)
      .map((commandId) => ({
        commandId,
        args: { trackId: selection.trackId },
        respectWhen: true as const,
      }));
  }
  return [];
}
