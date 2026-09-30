type PlaybackClock = () => number | null;

let activeClock: PlaybackClock | null = null;

export function bindPlaybackClock(clock: PlaybackClock): () => void {
  activeClock = clock;
  return () => {
    if (activeClock === clock) activeClock = null;
  };
}

export function playbackPositionSec(): number | null {
  const position = activeClock?.();
  return position != null && Number.isFinite(position) ? position : null;
}
