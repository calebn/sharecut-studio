import { encodePcmWav } from "../audio/wavHeader";
import { openKeeperTap } from "./keeper/graph";
import { KEEPER_SAMPLE_RATE, toKeeperPcm } from "./keeper/pcm";
import { e2eRoomTonePcm } from "./monitor/e2eHook";
import { ROOM_TONE_DURATION_SEC } from "./types";

export type EncodedRoomTone = {
  wav: Uint8Array;
  samples: Float32Array;
};

export async function encodeRoomToneWav(
  stream: MediaStream,
  options?: { durationSec?: number; signal?: AbortSignal },
): Promise<EncodedRoomTone> {
  const durationSec = options?.durationSec ?? ROOM_TONE_DURATION_SEC;
  const signal = options?.signal;
  const needed = Math.max(1, Math.round(durationSec * KEEPER_SAMPLE_RATE));
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const chunks: Int16Array[] = [];
  const floats: Float32Array[] = [];
  let collected = 0;
  let gotEnough = false;
  let settleEnough: (() => void) | undefined;
  let failEnough: ((err: unknown) => void) | undefined;
  const enough = new Promise<void>((resolve, reject) => {
    settleEnough = resolve;
    failEnough = reject;
  });
  const onAbort = () => {
    failEnough?.(new DOMException("Aborted", "AbortError"));
  };
  const onEnded = () => {
    failEnough?.(new DOMException("Ended", "AbortError"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const tracks = stream.getAudioTracks?.() ?? [];
  for (const track of tracks) {
    track.addEventListener("ended", onEnded, { once: true });
  }
  const timeoutMs = Math.max(1000, durationSec * 2 * 1000);
  const timer = setTimeout(() => {
    failEnough?.(new Error("room tone capture timed out"));
  }, timeoutMs);
  let stopTap: (() => void) | undefined;
  try {
    const collectPcm = (pcm: Float32Array, sourceRate: number) => {
      if (collected >= needed) {
        return;
      }
      const int16 = toKeeperPcm(pcm, sourceRate);
      chunks.push(int16);
      floats.push(pcm);
      collected += int16.length;
      if (collected >= needed) {
        gotEnough = true;
        settleEnough?.();
      }
    };
    const testPcm = e2eRoomTonePcm(KEEPER_SAMPLE_RATE, durationSec);
    if (testPcm) {
      collectPcm(testPcm, KEEPER_SAMPLE_RATE);
    } else {
      stopTap = (await openKeeperTap(stream, collectPcm)).stop;
    }
    if (!gotEnough) {
      await enough;
    }
  } finally {
    clearTimeout(timer);
    for (const track of tracks) {
      track.removeEventListener("ended", onEnded);
    }
    signal?.removeEventListener("abort", onAbort);
    stopTap?.();
  }
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const pcm = new Int16Array(Math.min(collected, needed));
  let offset = 0;
  for (let i = 0; i < chunks.length && offset < pcm.length; i++) {
    const chunk = chunks[i];
    if (!chunk) {
      continue;
    }
    const take = Math.min(chunk.length, pcm.length - offset);
    pcm.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  let floatCount = 0;
  for (const chunk of floats) {
    floatCount += chunk.length;
  }
  const samples = new Float32Array(floatCount);
  let floatOffset = 0;
  for (const chunk of floats) {
    samples.set(chunk, floatOffset);
    floatOffset += chunk.length;
  }
  return { wav: encodePcmWav(pcm, KEEPER_SAMPLE_RATE, 1), samples };
}
