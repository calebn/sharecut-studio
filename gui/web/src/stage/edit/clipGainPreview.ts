import { endPreview, showPreview } from "../../document/applyDocumentUpdate";
import { patchClipGain } from "../../document/projectPatch";
import type { ProjectView } from "../../types/project";

let held: { clipId: string; owner: symbol; baselineDb: number } | null = null;

const keyOf = (clipId: string) => `clipgain:${clipId}`;

function savedGain(project: ProjectView, clipId: string): number | undefined {
  for (const lane of Object.values(project.clips.tracks)) {
    const clip = lane.find((c) => c.id === clipId);
    if (clip) return clip.gain_db ?? 0;
  }
  return undefined;
}

export function savedClipGain(clipId: string, displayedDb: number): number {
  return held?.clipId === clipId ? held.baselineDb : displayedDb;
}

export function showClipGainPreview(
  clipId: string,
  displayedDb: number,
  gainDb: number,
): void {
  if (held && held.clipId !== clipId) endClipGainPreview(false, 0);
  held ??= {
    clipId,
    owner: Symbol(keyOf(clipId)),
    baselineDb: displayedDb,
  };
  const apply = (project: ProjectView) =>
    patchClipGain(project, clipId, gainDb);
  showPreview(keyOf(clipId), held.owner, apply, apply, () => true);
}

export function endClipGainPreview(revert: boolean, shownDb: number): void {
  if (!held) return;
  const { clipId, owner, baselineDb } = held;
  held = null;
  endPreview(
    keyOf(clipId),
    owner,
    revert
      ? (project) =>
          savedGain(project, clipId) === shownDb
            ? patchClipGain(project, clipId, baselineDb)
            : project
      : undefined,
  );
}
