export type PlaybackMeterSource = {
  read: (trackId: string) => ArrayLike<number> | null;
};

let source: PlaybackMeterSource | null = null;
const listeners = new Set<() => void>();

export function bindPlaybackMeterSource(next: PlaybackMeterSource): () => void {
  source = next;
  for (const listener of listeners) listener();
  return () => {
    if (source !== next) return;
    source = null;
    for (const listener of listeners) listener();
  };
}

export function playbackMeterSource(): PlaybackMeterSource | null {
  return source;
}

export function subscribePlaybackMeterSource(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
