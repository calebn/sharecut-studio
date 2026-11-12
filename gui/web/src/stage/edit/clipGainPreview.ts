import { endPreview, showPreview } from "../../document/applyDocumentUpdate";
import { documentAuthority } from "../../document/authorityState";
import { patchClipGain } from "../../document/projectPatch";
import type { ProjectView } from "../../types/project";
import { clipGainDb } from "../../utils/audio";

type ActivePreview = {
  clipId: string;
  owner: symbol;
  baselineDb: number;
  shownDb: number;
};

let activePreview: ActivePreview | null = null;

const previewKey = (clipId: string) => `clipgain:${clipId}`;

function gainIn(project: ProjectView, clipId: string): number | undefined {
  for (const lane of Object.values(project.clips.tracks)) {
    const clip = lane.find((c) => c.id === clipId);
    if (clip) return clipGainDb(clip);
  }
  return undefined;
}

/** The gain a save of this clip is based on: the one before the scrub began, else the displayed one. */
export function previewBaselineDb(clipId: string, displayedDb: number): number {
  return activePreview?.clipId === clipId
    ? activePreview.baselineDb
    : displayedDb;
}

export function showClipGainPreview(
  clipId: string,
  displayedDb: number,
  gainDb: number,
): void {
  if (activePreview && activePreview.clipId !== clipId) {
    endClipGainPreview(activePreview.clipId, true);
  }
  const preview: ActivePreview = activePreview ?? {
    clipId,
    owner: Symbol(previewKey(clipId)),
    baselineDb: displayedDb,
    shownDb: displayedDb,
  };
  const apply = (project: ProjectView) =>
    patchClipGain(project, clipId, gainDb);
  showPreview(previewKey(clipId), preview.owner, apply, apply, () => true);
  preview.shownDb = gainDb;
  activePreview = preview;
}

/** Drop the preview; `revert` also puts the saved gain back. A preview on another clip is always put back. */
export function endClipGainPreview(clipId: string, revert: boolean): void {
  if (!activePreview) return;
  const { owner, baselineDb, shownDb } = activePreview;
  const previewClipId = activePreview.clipId;
  activePreview = null;
  const putBack = revert || previewClipId !== clipId;
  endPreview(
    previewKey(previewClipId),
    owner,
    putBack
      ? (project) =>
          gainIn(project, previewClipId) === shownDb
            ? patchClipGain(
                project,
                previewClipId,
                (documentAuthority.project
                  ? gainIn(documentAuthority.project, previewClipId)
                  : undefined) ?? baselineDb,
              )
            : project
      : undefined,
  );
}
