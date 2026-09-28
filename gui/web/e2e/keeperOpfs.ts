import type { Page } from "@playwright/test";
import { PCM_WAV_HEADER_BYTES } from "../src/audio/wavHeader";
import {
  KEEPER_OPFS_ROOT,
  keeperSegmentIndex,
} from "../src/record/keeper/opfsPath";
import {
  KEEPER_FRAME_BYTES,
  KEEPER_SAMPLE_RATE,
} from "../src/record/keeper/pcm";

/** One second of keeper PCM (48 kHz mono s16). */
export const ONE_SECOND_KEEPER_PCM_BYTES =
  KEEPER_SAMPLE_RATE * KEEPER_FRAME_BYTES;
export const ONE_SECOND_KEEPER_WAV_BYTES =
  PCM_WAV_HEADER_BYTES + ONE_SECOND_KEEPER_PCM_BYTES;

export type RecordingWav = { path: string; size: number; header: number[] };

/**
 * Every readable `.wav` under the keeper OPFS root; null when that directory
 * does not exist. A keeper still being written can be locked and is skipped
 * without any signal, so the result can be a subset: call this inside
 * `expect.poll(...)`, never as a one-shot read.
 */
export async function recordingWavs(
  page: Page,
): Promise<RecordingWav[] | null> {
  return page.evaluate(async (rootName) => {
    const root = await navigator.storage.getDirectory();
    let recordings: FileSystemDirectoryHandle;
    try {
      recordings = await root.getDirectoryHandle(rootName);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") {
        return null;
      }
      throw error;
    }
    const out: Array<{ path: string; size: number; header: number[] }> = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      for await (const [name, handle] of dir.entries()) {
        const childPath = `${prefix}/${name}`;
        if (handle.kind === "directory") {
          await walk(handle as FileSystemDirectoryHandle, childPath);
          continue;
        }
        if (!name.endsWith(".wav")) continue;
        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          out.push({
            path: childPath,
            size: file.size,
            header: Array.from(
              new Uint8Array(await file.slice(0, 12).arrayBuffer()),
            ),
          });
        } catch {
          // A keeper still being written can be locked; the next poll reads it.
        }
      }
    };
    await walk(recordings, "");
    return out;
  }, KEEPER_OPFS_ROOT);
}

/**
 * Size of the largest keeper `.wav`, or 0 when there is none. It inherits
 * `recordingWavs`' silent skip of locked files, so a single read can be stale
 * or 0: only use it inside `expect.poll(...)`.
 */
export async function keeperWavBytes(page: Page): Promise<number> {
  return Math.max(
    0,
    ...((await recordingWavs(page)) ?? []).map((wav) => wav.size),
  );
}

/** Identifies one keeper directory (`keeperWavPath` in `src/record/keeper/store.ts`). */
export type KeeperRef = {
  sessionId: string;
  takeIndex: number;
  participantId: string;
};

/**
 * Unique, ascending segment indexes named by `<n>.wav` or `<n>.json` entries
 * (`keeperSegmentIndex` in `src/record/keeper/opfsPath.ts`, shared with the
 * keeper store). A segment counts from either name, so a WAV still mid-write
 * (locked, only its `.json` sidecar readable, or vice versa) still counts. A
 * segment whose WAV `pruneExpiredKeeperWavs` removed also still counts from
 * its pruned marker `<n>.json` (`prunedKeeperMarker` in
 * `src/record/keeper/store.ts`), so this lists every segment written, not
 * only WAVs still on disk.
 */
export function segmentIndexesFromNames(names: string[]): number[] {
  const indexes = new Set<number>();
  for (const name of names) {
    const index = keeperSegmentIndex(name);
    if (index !== null) {
      indexes.add(index);
    }
  }
  return [...indexes].sort((a, b) => a - b);
}

/** Entry names of one keeper directory, plus one WAV's byte size when asked. */
type KeeperDirRead = { names: string[]; wavBytes: number };

/**
 * In the page, open `keeper`'s OPFS directory directly (no tree walk), list its
 * entry names, and read the byte size of `wavName` when given. A missing
 * directory reads as no names; a missing or locked WAV reads as 0 bytes.
 */
async function readKeeperDir(
  page: Page,
  keeper: KeeperRef,
  wavName: string | null,
): Promise<KeeperDirRead> {
  return page.evaluate(
    async ({ rootName, parts, wavName }) => {
      let dir: FileSystemDirectoryHandle =
        await navigator.storage.getDirectory();
      try {
        for (const part of [rootName, ...parts]) {
          dir = await dir.getDirectoryHandle(part);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") {
          return { names: [], wavBytes: 0 };
        }
        throw error;
      }
      const names: string[] = [];
      for await (const name of dir.keys()) {
        names.push(name);
      }
      let wavBytes = 0;
      if (wavName !== null && names.includes(wavName)) {
        try {
          wavBytes = (await (await dir.getFileHandle(wavName)).getFile()).size;
        } catch {
          // A keeper still being written can be locked; the next poll reads it.
        }
      }
      return { names, wavBytes };
    },
    {
      rootName: KEEPER_OPFS_ROOT,
      parts: [keeper.sessionId, String(keeper.takeIndex), keeper.participantId],
      wavName,
    },
  );
}

/**
 * Segment indexes present in `keeper`'s OPFS directory, read from directory
 * entry names rather than opened files, so a WAV still being written (locked)
 * still counts. Pruned segments still count (see segmentIndexesFromNames).
 * Returns `[]` when the keeper's directory does not exist yet.
 */
export async function keeperSegmentIndexes(
  page: Page,
  keeper: KeeperRef,
): Promise<number[]> {
  return segmentIndexesFromNames(
    (await readKeeperDir(page, keeper, null)).names,
  );
}

/**
 * Byte size of one keeper segment WAV, opened directly by path. A locked file
 * reads as 0, so poll this rather than reading it once. 0 when that segment
 * has no readable WAV yet.
 */
export async function keeperSegmentWavBytes(
  page: Page,
  keeper: KeeperRef,
  segmentIndex: number,
): Promise<number> {
  return (await readKeeperDir(page, keeper, `${segmentIndex}.wav`)).wavBytes;
}
