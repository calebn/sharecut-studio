import { errorMessage } from "../utils/apiError";
/**
 * Single ingest path for drop / picker / Import command.
 * Upload bytes then document commands (never fork probe/clip logic in the UI).
 */

import {
  addTrackCommand,
  refreshProject,
  setTrackMediaCommand,
  uploadMediaFile,
} from "../api";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { useDawStore } from "../state/dawStore";
import {
  formatIngestDuration,
  replaceAudioConfirmMessage,
  trackHasMedia,
} from "./dropLabels";

export type IngestTarget = { kind: "track"; id: string } | { kind: "new" };

function stemLabel(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "").trim();
  return base || "Track";
}

function slugId(filename: string): string {
  const stem = stemLabel(filename)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return stem || "track";
}

function uniqueTrackId(preferred: string, taken: Set<string>): string {
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

function focusImportedTrack(trackId: string): void {
  const s = useDawStore.getState();
  s.setSelectedTrackIds([trackId]);
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
  s.setIngestBusy(true);
  s.announceStatus(`Importing ${list.length} file(s)…`);
  let focusId: string | null = null;
  let replaced = false;
  try {
    if (target.kind === "track") {
      const first = list[0]!;
      const track = s.project?.tracks.find((t) => t.id === target.id);
      const laneClips = s.project?.clips?.tracks?.[target.id] ?? [];
      const hasClips = trackHasMedia({
        mediaPath: track?.media_path,
        clipCount: laneClips.length,
      });
      if (hasClips) {
        const ok = window.confirm(
          replaceAudioConfirmMessage(track?.label || target.id),
        );
        if (!ok) {
          return;
        }
        replaced = true;
      }
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
    const next = await refreshProject(projectPath);
    applyDocumentSnapshot({ project: next }, { force: true });
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
    s.announceStatus(`Import failed: ${reason}`);
  } finally {
    s.setIngestBusy(false);
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
