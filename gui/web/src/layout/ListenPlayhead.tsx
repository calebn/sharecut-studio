import { useDawStore } from "../state/dawStore";
import { seekListen } from "./listenSeek";

/**
 * Listen mode's playhead scrubber. It selects the playhead itself, so a tick
 * re-renders this leaf, not the Listen card and its comment list. The
 * timecode readout is `TransportTimecode`.
 */

export function ListenScrubber({ durationSec }: { durationSec: number }) {
  const playheadSec = useDawStore((s) => s.playheadSec);
  return (
    <input
      type="range"
      className="listen-scrub mobile-scrub"
      min={0}
      max={Math.max(durationSec, 0.01)}
      step={0.01}
      value={Math.min(playheadSec, durationSec)}
      aria-label="Scrub timeline"
      onChange={(e) => seekListen(Number(e.target.value))}
    />
  );
}
