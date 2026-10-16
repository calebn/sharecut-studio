import { useDawStore } from "../state/dawStore";
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
