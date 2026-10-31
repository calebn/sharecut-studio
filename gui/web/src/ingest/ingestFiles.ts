import { errorMessage } from "../utils/apiError";
/**
 * Single ingest path for drop / picker / Import command.
 * Upload bytes then document commands (never fork probe/clip logic in the UI).
 */

import { addTrackCommand, setTrackMediaCommand, uploadMediaFile } from "../api";
import { refreshDocumentProject } from "../document/applyDocumentUpdate";
import { askConfirm } from "../feedback/ask";
import { useDawStore } from "../state/dawStore";
import { formatIngestDuration } from "../utils/time";
import { replaceAudioQuestion, trackHasMedia } from "./dropLabels";

/** Imports under way: busy ends when the last one settles, not the first. */
let imports = 0;
let filesInFlight = 0;

export type IngestTarget = { kind: "track"; id: string } | { kind: "new" };

function stemLabel(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "").trim();
  return base || "Track";
}

/** A track id from free text: lowercase, `[a-z0-9_-]` only. */
export function slugText(text: string): string {
  const stem = text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return stem || "track";
}

function slugId(filename: string): string {
  return slugText(stemLabel(filename));
}

export function uniqueTrackId(preferred: string, taken: Set<string>): string {
  if (!taken.has(preferred)) {
    return preferred;
  }
  let i = 2;
  while (taken.has(`${preferred}_${i}`)) {
    i += 1;
  }
  return `${preferred}_${i}`;
}

async function createTrackWithMedia(
  projectPath: string,
  file: File,
  taken: Set<string>,
): Promise<string> {
  const tid = uniqueTrackId(slugId(file.name), taken);
  taken.add(tid);
  await addTrackCommand(projectPath, {
    track_id: tid,
    label: stemLabel(file.name),
  });
  const up = await uploadMediaFile(projectPath, file);
  await setTrackMediaCommand(projectPath, tid, up.rel_path!);
  return tid;
}

export type NewProjectIngest = {
  /** Files that became tracks before the first failure (all of them when none failed). */
  added: number;
  /** What stopped the import; later files were not tried. */
  failed?: unknown;
};

/**
 * Adds each file as a new track of a project the store has not opened yet
 * (Home's Import). Stops at the first failure and reports how many were added.
 */
export async function ingestIntoNewProject(
  projectPath: string,
  files: readonly File[],
): Promise<NewProjectIngest> {
  const taken = new Set<string>();
  let added = 0;
  for (const file of files) {
    try {
      await createTrackWithMedia(projectPath, file, taken);
    } catch (failed: unknown) {
      return { added, failed };
    }
    added += 1;
  }
  return { added };
}

function focusImportedTrack(trackId: string): void {
  const s = useDawStore.getState();
  s.setSelection({ kind: "track", trackId });
}

function announceImportResult(
  trackId: string,
  opts: { replaced: boolean },
): void {
  const s = useDawStore.getState();
  const track = s.project?.tracks.find((t) => t.id === trackId);
  const label = track?.label || trackId;
  const verb = opts.replaced ? "Replaced" : "Added";
  const dur = track?.duration_sec;
  if (dur != null && dur > 0) {
    s.announceStatus(`${verb} ${label} · ${formatIngestDuration(dur)}`);
  } else {
    s.announceStatus(`${verb} ${label}`);
  }
}

export async function ingestFiles(
  files: File[],
  target: IngestTarget,
): Promise<void> {
  const s = useDawStore.getState();
  const projectPath = s.projectPath;
  if (!projectPath || !files.length) {
    return;
  }

  const list = [...files];
  const taken = new Set((s.project?.tracks ?? []).map((t) => t.id));
  let replaced = false;
  if (target.kind === "track") {
    const track = s.project?.tracks.find((t) => t.id === target.id);
    replaced = trackHasMedia({
      mediaPath: track?.media_path,
      clipCount: s.project?.clips?.tracks?.[target.id]?.length ?? 0,
    });
    if (
      replaced &&
      (!(await askConfirm(replaceAudioQuestion(track?.label || target.id))) ||
        useDawStore.getState().projectPath !== projectPath)
    ) {
      return;
    }
  }
  imports += 1;
  filesInFlight += list.length;
  s.setIngestBusy(true, filesInFlight);
  s.announceStatus(`Importing ${list.length} file(s)…`);
  let focusId: string | null = null;
  try {
    if (target.kind === "track") {
      const first = list[0]!;
      const uploaded = await uploadMediaFile(projectPath, first);
      await setTrackMediaCommand(projectPath, target.id, uploaded.rel_path!);
      focusId = target.id;
      for (const extra of list.slice(1)) {
        focusId = await createTrackWithMedia(projectPath, extra, taken);
        replaced = false;
      }
    } else {
      for (const file of list) {
        focusId = await createTrackWithMedia(projectPath, file, taken);
      }
    }
    await refreshDocumentProject(projectPath);
    if (focusId) {
      focusImportedTrack(focusId);
      announceImportResult(focusId, { replaced });
    } else {
      s.announceStatus("Import complete");
    }
  } catch (err) {
    // Every call site is fire-and-forget with no rejection handler, so the
    // error must surface here or the UI stalls on "Importing…" forever (#223).
    const reason = errorMessage(err);
    s.announceStatus(`Import failed: ${reason}`, { tone: "error" });
    // Files before the failing one may have landed. Refresh so they show and
    // the stage sees their audio (Prepare starts its run from that change).
    try {
      await refreshDocumentProject(projectPath);
    } catch {
      // The failure above is already announced.
    }
  } finally {
    imports -= 1;
    filesInFlight -= list.length;
    if (imports === 0) s.setIngestBusy(false);
    else s.setIngestBusy(true, filesInFlight);
  }
}

export function pickAudioFiles(multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*,.wav,.mp3,.m4a,.flac,.aiff,.aif,.ogg";
    input.multiple = multiple;
    input.style.display = "none";
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener("focus", onWindowFocus);
      input.remove();
      resolve(files);
    };
    const onWindowFocus = () => {
      window.setTimeout(() => {
        finish(input.files ? Array.from(input.files) : []);
      }, 300);
    };
    input.onchange = () => {
      finish(input.files ? Array.from(input.files) : []);
    };
    input.addEventListener("cancel", () => finish([]));
    window.addEventListener("focus", onWindowFocus);
    document.body.appendChild(input);
    input.click();
  });
}
