import { formatGainDb } from "../utils/audio";
import { useVolumeEnvelopeDb } from "./useVolumeEnvelopeDb";

/**
 * What a track with a volume envelope plays at, under its Mix sheet fader:
 * `baseDb` (staging plus the fader, draft included) plus the envelope at the
 * playhead. A leaf, so only this line re-renders as the playhead moves.
 */
export function TrackPlaysAt({
  trackId,
  baseDb,
}: {
  trackId: string;
  baseDb: number;
}) {
  const envelopeDb = useVolumeEnvelopeDb(trackId);
  if (envelopeDb === undefined) {
    return null;
  }
  return (
    <span className="track-fader-plays-at">
      Plays at {formatGainDb(baseDb + envelopeDb)}
    </span>
  );
}
