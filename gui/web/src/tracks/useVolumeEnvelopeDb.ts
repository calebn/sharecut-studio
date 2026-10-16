import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { roundGainDb } from "../utils/audio";
import { volumeEnvelopeDbAt } from "../utils/envelopes";

/**
 * The track's volume envelope gain (dB) at the playhead, or undefined without
 * one. Selected already rounded to the label's 0.1 dB so a consumer re-renders
 * only when its readout changes, not on every playhead tick.
 */
export function useVolumeEnvelopeDb(trackId: string): number | undefined {
  return useDawStore((s) => {
    const db = volumeEnvelopeDbAt(s.project?.envelopes, trackId, s.playheadSec);
    return db === null ? undefined : roundGainDb(db);
  });
}

/**
 * `useVolumeEnvelopeDb` for every track that has a volume envelope, keyed by
 * track id (the Mix sheet lists them all). `useDaw` compares the record
 * shallowly, so the sheet re-renders when a readout changes, not every tick.
 */
export function useVolumeEnvelopeDbs(): Readonly<Record<string, number>> {
  return useDaw((s) => {
    const out: Record<string, number> = {};
    for (const track of s.project?.tracks ?? []) {
      const db = volumeEnvelopeDbAt(
        s.project?.envelopes,
        track.id,
        s.playheadSec,
      );
      if (db !== null) {
        out[track.id] = roundGainDb(db);
      }
    }
    return out;
  });
}
