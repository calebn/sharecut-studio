import { useDawStore } from "../state/dawStore";
import { Timecode } from "../ui";
import { transportTimecode } from "../utils/time";
import { seekListen } from "./listenSeek";

/**
 * Listen mode's playhead readouts. They select the playhead themselves, so a
 * tick re-renders these leaves, not the Listen card and its comment list.
 */

export function ListenTimecode({ durationSec }: { durationSec: number }) {
  const playheadSec = useDawStore((s) => s.playheadSec);
  return <Timecode {...transportTimecode(playheadSec, durationSec)} />;
}

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
