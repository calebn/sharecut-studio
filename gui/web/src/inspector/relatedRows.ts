import { COMMANDS } from "../commands/catalog";
import { type CommandContext, evaluateWhen } from "../commands/context";
import { oneWordOf } from "../transcript/rangeSelect";
import type { ProjectView, Selection } from "../types/project";

export type RelatedCommandDescriptor = {
  /** Related actions always honor the command catalog's availability gate. */
  respectWhen: true;
  /** What the person reads when that gate holds the action back. */
  whenReason: string;
} & (
  | { commandId: "edit.copy"; args: Record<string, never> }
  | { commandId: "edit.cut"; args: { clipId: string } }
  | {
      commandId: "track.moveUp" | "track.moveDown";
      args: { trackId: string };
    }
);

type Chosen = NonNullable<Selection>;
type Of<K extends Chosen["kind"]> = Extract<Chosen, { kind: K }>;

const COPY_SELECTION: RelatedCommandDescriptor = {
  commandId: "edit.copy",
  args: {},
  respectWhen: true,
  whenReason: "Select a clip or word to copy.",
};

/** Related: Copy, for a clip. */
export const relatedCopy = (): readonly RelatedCommandDescriptor[] => [
  COPY_SELECTION,
];

/** Related: Copy, for one word. A longer range has its own actions in the sheet. */
export const relatedCopyWord = (
  selection: Of<"transcriptRange">,
): readonly RelatedCommandDescriptor[] =>
  oneWordOf(selection) ? [COPY_SELECTION] : [];

/** More: Cut, for a clip that is still in the project and may be cut. */
export function moreCutClip(
  selection: Of<"clip">,
  project: ProjectView,
  context: CommandContext,
): readonly RelatedCommandDescriptor[] {
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
      whenReason: "Select a clip to cut.",
    },
  ];
}

/** More: Move up and Move down, for a track, only in the directions that exist. */
export function moreMoveTrack(
  selection: Of<"track">,
  project: ProjectView,
  context: CommandContext,
): readonly RelatedCommandDescriptor[] {
  if (!project.tracks.some((track) => track.id === selection.trackId)) {
    return [];
  }
  return (["track.moveUp", "track.moveDown"] as const)
    .filter((commandId) => evaluateWhen(COMMANDS[commandId].when, context).ok)
    .map((commandId) => ({
      commandId,
      args: { trackId: selection.trackId },
      respectWhen: true as const,
      whenReason:
        commandId === "track.moveUp"
          ? "This track is already first."
          : "This track is already last.",
    }));
}
