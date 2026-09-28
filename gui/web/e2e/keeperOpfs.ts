import type { Page } from "@playwright/test";
import { PCM_WAV_HEADER_BYTES } from "../src/audio/wavHeader";
import { KEEPER_OPFS_ROOT } from "../src/record/keeper/opfsPath";
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
