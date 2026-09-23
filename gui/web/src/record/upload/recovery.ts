import { holdKeeperReclaim } from "../keeper/reclaim";
import {
  type ByteSink,
  keeperMetaComplete,
  keeperMetaPath,
  keeperWavPath,
  missingKeeperWavState,
} from "../keeper/store";
import { KEEPER_ALL_RECLAIMED_COPY } from "../types";
import { makeKeeperArchive } from "./archive";

async function keeperBlob(sink: ByteSink, path: string): Promise<Blob | null> {
  if (sink.readBlob) return sink.readBlob(path);
  const bytes = await sink.read(path);
  if (!bytes) return null;
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return new Blob([copy.buffer], { type: "audio/wav" });
}

/**
 * Keeper reclaim stays paused this long after a recovery download is handed
 * to the browser: the archive references OPFS `File`s that are read lazily
 * while the download is written, so deleting one would fail the ZIP.
 */
export const RECOVERY_RECLAIM_GRACE_MS = 5 * 60_000;

async function withReclaimHeld<T>(
  sink: ByteSink,
  run: () => Promise<T>,
): Promise<T> {
  const release = await holdKeeperReclaim(sink);
  try {
    return await run();
  } finally {
    window.setTimeout(release, RECOVERY_RECLAIM_GRACE_MS);
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function downloadLocalKeeper(
  sink: ByteSink,
  path: string,
  filename: string,
): Promise<boolean> {
  return withReclaimHeld(sink, async () => {
    const blob = await keeperBlob(sink, path);
    if (!blob) return false;
    downloadBlob(blob, filename);
    return true;
  });
}

export async function downloadLocalKeepers(
  sink: ByteSink,
  sessionId: string,
  participantId: string,
  lastTakeIndex: number,
): Promise<void> {
  return withReclaimHeld(sink, async () => {
    let downloaded = 0;
    let missing = 0;
    let reclaimed = 0;
    const entries: Array<{ filename: string; data: Blob }> = [];
    for (let take = 0; take <= lastTakeIndex; take += 1) {
      const count = await sink.nextSegmentIndex(sessionId, take, participantId);
      for (let segment = 0; segment < count; segment += 1) {
        const path = keeperWavPath({
          sessionId,
          takeIndex: take,
          participantId,
          segmentIndex: segment,
        });
        const blob = await keeperBlob(sink, path);
        if (blob) {
          // A WAV without completion metadata stopped mid-write (its header
          // may still report zero data bytes); label it rather than pass it
          // off as a finished segment.
          const complete = keeperMetaComplete(
            await sink.read(keeperMetaPath(path)),
          );
          const suffix = complete ? "" : "-partial";
          entries.push({
            filename: `keeper-${take}-${segment}${suffix}.wav`,
            data: blob,
          });
          downloaded += 1;
        } else if ((await missingKeeperWavState(sink, path)) === "reclaimed") {
          // Landed safely on the host and cleared locally; not lost audio.
          reclaimed += 1;
        } else {
          missing += 1;
        }
      }
    }
    if (downloaded === 0 && missing === 0 && reclaimed > 0) {
      throw new Error(KEEPER_ALL_RECLAIMED_COPY);
    }
    if (downloaded === 0) {
      throw new Error("No local keeper copy is available to download.");
    }
    const archive = await makeKeeperArchive(entries);
    downloadBlob(archive, `keepers-${participantId}.zip`);
    if (missing > 0) {
      throw new Error(
        `Downloaded ${downloaded} local keeper ${downloaded === 1 ? "copy" : "copies"}; ${missing} missing ${missing === 1 ? "segment" : "segments"} could not be exported.`,
      );
    }
  });
}
