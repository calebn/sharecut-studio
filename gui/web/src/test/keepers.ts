import { pcmWavHeader } from "../audio/wavHeader";
import {
  type ByteSink,
  keeperWavPath,
  writeKeeperMeta,
} from "../record/keeper/store";

/** Seed an interrupted (complete:false) keeper segment with readable PCM. */
export async function seedPendingKeeper(
  sink: ByteSink,
  ids: {
    sessionId: string;
    takeIndex: number;
    participantId: string;
    segmentIndex?: number;
  },
  pcm: number[] = [1, 0, 2, 0],
): Promise<string> {
  const meta = { segmentIndex: 0, ...ids };
  const wavPath = keeperWavPath(meta);
  const wav = new Uint8Array(44 + pcm.length);
  wav.set(pcmWavHeader(0), 0);
  wav.set(pcm, 44);
  await sink.write(wavPath, wav);
  await writeKeeperMeta(sink, wavPath, {
    ...meta,
    sampleRate: 48_000,
    joinOffsetMs: 0,
    samplesWritten: 0,
    complete: false,
  });
  return wavPath;
}
