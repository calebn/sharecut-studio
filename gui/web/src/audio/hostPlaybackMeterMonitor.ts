import { audioContextCtor } from "../utils/audio";
import { createChannelPeakTap } from "./channelPeakTap";

export type HostMeterTrack = {
  id: string;
  url: string;
  gain: number;
  mediaSec: number | null;
};

type HostMeterClock = { playbackRate: number };
type MonitorEntry = {
  url: string;
  media: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  tap: ReturnType<typeof createChannelPeakTap>;
  failed: boolean;
  starting: boolean;
  events: AbortController;
};

const SILENCE = new Float32Array(2);

export function createHostPlaybackMeterMonitor(options: {
  tracks: () => HostMeterTrack[];
  clock: () => HostMeterClock | null;
}) {
  const entries = new Map<string, MonitorEntry>();
  let context: AudioContext | null = null;
  let disposed = false;
  let unavailable = false;
  let snapshot = new Map<string, HostMeterTrack>();
  let activeRate = 1;
  let active = false;

  const release = (entry: MonitorEntry) => {
    entry.events.abort();
    entry.media.pause();
    entry.media.removeAttribute("src");
    entry.media.load();
    entry.tap.dispose();
    entry.source.disconnect();
    entry.gain.disconnect();
  };

  const synchronize = () => {
    const clock = disposed ? null : options.clock();
    if (!clock) {
      active = false;
      for (const entry of entries.values()) entry.media.pause();
      if (context?.state === "running")
        void context.suspend().catch(() => {
          unavailable = true;
        });
      return;
    }
    active = true;
    if (context?.state === "suspended")
      void context.resume().catch(() => {
        unavailable = true;
      });
    const tracks = options.tracks();
    snapshot = new Map(tracks.map((track) => [track.id, track]));
    activeRate = clock.playbackRate;
    for (const [id, entry] of entries) {
      if (snapshot.get(id)?.url !== entry.url) {
        release(entry);
        entries.delete(id);
      }
    }
    for (const track of tracks) {
      const entry = entries.get(track.id);
      if (!entry) continue;
      entry.gain.gain.value = track.gain;
      entry.media.playbackRate = clock.playbackRate;
      if (track.mediaSec === null || track.gain === 0) {
        entry.media.pause();
        continue;
      }
      if (entry.failed || entry.media.readyState < 2) continue;
      if (Math.abs(entry.media.currentTime - track.mediaSec) > 0.08) {
        entry.media.currentTime = track.mediaSec;
      }
      if (entry.media.paused && !entry.starting) {
        entry.starting = true;
        void entry.media
          .play()
          .catch((error: unknown) => {
            const current = snapshot.get(track.id);
            if (
              (error instanceof Error && error.name === "AbortError") ||
              disposed ||
              !options.clock() ||
              current?.gain === 0 ||
              current?.mediaSec === null
            )
              return;
            entry.failed = true;
          })
          .finally(() => {
            entry.starting = false;
            if (disposed || !options.clock()) entry.media.pause();
          });
      }
    }
  };

  const sync = () => {
    try {
      synchronize();
    } catch {
      unavailable = true;
    }
  };

  const createEntry = (track: HostMeterTrack): MonitorEntry | null => {
    const cleanup: (() => void)[] = [];
    try {
      if (!context) {
        const Context = audioContextCtor();
        if (!Context) {
          unavailable = true;
          return null;
        }
        context = new Context();
      }
      if (context.state === "suspended")
        void context.resume().catch(() => {
          unavailable = true;
        });
      const media = new Audio();
      cleanup.push(() => {
        media.pause();
        media.removeAttribute("src");
        media.load();
      });
      media.crossOrigin = "anonymous";
      media.preload = "auto";
      const source = context.createMediaElementSource(media);
      cleanup.push(() => source.disconnect());
      const gain = context.createGain();
      cleanup.push(() => gain.disconnect());
      gain.gain.value = track.gain;
      media.playbackRate = activeRate;
      source.connect(gain);
      const tap = createChannelPeakTap(context, gain);
      cleanup.push(() => tap.dispose());
      const events = new AbortController();
      cleanup.push(() => events.abort());
      const entry: MonitorEntry = {
        url: track.url,
        media,
        source,
        gain,
        tap,
        events,
        failed: false,
        starting: false,
      };
      media.addEventListener(
        "error",
        () => {
          entry.failed = true;
        },
        { signal: events.signal },
      );
      media.src = track.url;
      entries.set(track.id, entry);
      return entry;
    } catch {
      for (const dispose of cleanup.reverse()) dispose();
      unavailable = true;
      return null;
    }
  };

  sync();

  return {
    sync,
    read(trackId: string): ArrayLike<number> | null {
      if (disposed || !options.clock()) {
        if (active) sync();
        return null;
      }
      const track = snapshot.get(trackId);
      if (!track) return null;
      if (track.gain === 0 || track.mediaSec === null) return SILENCE;
      if (unavailable) return null;
      try {
        const entry = entries.get(trackId) ?? createEntry(track);
        if (!entry) return null;
        if (
          entry.failed ||
          entry.media.paused ||
          entry.media.seeking ||
          entry.media.readyState < 2 ||
          context?.state !== "running"
        )
          return null;
        return entry.tap.read();
      } catch {
        return null;
      }
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) release(entry);
      entries.clear();
      if (context) void context.close().catch(() => {});
      context = null;
    },
  };
}
