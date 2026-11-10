import { apiSend, HOST_KEY } from "../api";
import { audioContextCtor } from "../utils/audio";
import { createChannelPeakTap } from "./channelPeakTap";
import { pcmWavHeader } from "./wavHeader";

type HostMeterAsset = { url: string } & (
  | { delivery: "native" }
  | { delivery: "wav" | "probe"; readUrl: string }
);

export type HostMeterTrack = HostMeterAsset & {
  id: string;
  gain: number;
  mediaSec: number | null;
};

type HostMeterClock = { playbackRate: number };
type ReaderTarget = {
  localSec: number;
  gain: number;
  playbackRate: number;
  gains?: number[];
};
type ReaderBranch = {
  gain: GainNode;
  tap: ReturnType<typeof createChannelPeakTap>;
};
type NativeRun = {
  observedSec: number;
  warmOnProgress?: boolean;
};
type NativeReader = {
  media: HTMLAudioElement;
  events: AbortController;
  starting: boolean;
  current: () => ReaderTarget | "waiting" | null;
  playback: "synchronized" | "prepared";
  state:
    | {
        kind: "priming";
        position: {
          playingAt: number | null;
          seek: "pending" | number | null;
        } | null;
      }
    | {
        kind: "bound";
        source: MediaElementAudioSourceNode;
        gain: GainNode;
        tap: ReturnType<typeof createChannelPeakTap>;
        branches: ReaderBranch[];
        connections: AudioNode[];
        warmAfter: number;
        rawSeekProgress: "pending" | number | null;
        run: NativeRun | null;
      }
    | { kind: "failed" }
    | { kind: "released" };
};
type AssetIdentity = { etag: string; total: number };
type PcmLayout = {
  identity: AssetIdentity;
  sampleRate: number;
  channels: number;
  blockAlign: number;
  dataOffset: number;
  frames: number;
};
type WavMember = { id: string; entry: WavEntry; layout: PcmLayout };
type WavAssembly = {
  members: (WavMember & { window: WavWindow })[];
  released: boolean;
  payload: Uint8Array<ArrayBuffer> | null;
};
type WavWindow = {
  assembly: WavAssembly;
  branch: number;
  observed: { run: NativeRun; sec: number } | null;
  first: number;
  end: number;
  turn: number;
  hop: number;
  overlap: number;
  abort: AbortController;
  local: { url: string; reader: NativeReader } | null;
  history: {
    run: NativeRun;
    gain: number;
    playbackRate: number;
    capturedAt: number;
    blocks: { observedTrackSec: number; samples: Float32Array }[];
  } | null;
};
type WavEntry = {
  delivery: "wav";
  asset: HostMeterAsset & { delivery: "wav" | "probe" };
  abort: AbortController;
  state:
    | { kind: "opening" }
    | {
        kind: "ready";
        layout: PcmLayout;
        windows: WavWindow[];
        demand: {
          mediaSec: number;
          contextSec: number;
          playbackRate: number;
        } | null;
      }
    | { kind: "failed" };
};
type MonitorEntry =
  | { delivery: "native"; asset: HostMeterAsset; reader: NativeReader }
  | WavEntry;

const SILENCE = new Float32Array(2);
const TAP_FRAMES = 2048;
const WINDOW_TAPS = 128;
const OVERLAP_TAPS = 4;
const WINDOW_BYTES =
  TAP_FRAMES * WINDOW_TAPS * 2 * Int16Array.BYTES_PER_ELEMENT;

async function finiteRange(
  url: string,
  start: number,
  length: number,
  abort: AbortController,
  identity?: AssetIdentity,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; identity: AssetIdentity }> {
  const end = start + length - 1;
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(end) ||
    length <= 0
  )
    throw new Error("Invalid meter byte range");
  const response = await apiSend(
    HOST_KEY,
    { url },
    {
      signal: abort.signal,
      headers: {
        Range: `bytes=${start}-${end}`,
        ...(identity ? { "If-Range": identity.etag } : {}),
      },
    },
  );
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
    response.headers.get("Content-Range") ?? "",
  );
  const total = Number(range?.[3]);
  const etag = response.headers.get("ETag") ?? "";
  const encoding = response.headers.get("Content-Encoding");
  if (
    abort.signal.aborted ||
    response.status !== 206 ||
    !range ||
    Number(range[1]) !== start ||
    Number(range[2]) !== end ||
    !Number.isSafeInteger(total) ||
    total <= end ||
    response.headers.get("Content-Length") !== String(length) ||
    !/^"[^"\r\n]+"$/.test(etag) ||
    (encoding !== null && encoding !== "identity") ||
    response.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("multipart/") ||
    (identity && (identity.etag !== etag || identity.total !== total)) ||
    !response.body
  ) {
    abort.abort();
    await response.body?.cancel().catch(() => {});
    throw new Error("Invalid finite meter response");
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  abort.signal.addEventListener("abort", cancel, { once: true });
  try {
    const bytes = new Uint8Array(length);
    let offset = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (abort.signal.aborted) throw new Error("Retired meter read");
      if (done) break;
      if (offset + value.byteLength > length)
        throw new Error("Oversized meter response");
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== length) throw new Error("Truncated meter response");
    return { bytes, identity: { etag, total } };
  } catch (error) {
    abort.abort();
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    abort.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function fourcc(bytes: Uint8Array, offset = 0): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function sameAsset(left: HostMeterAsset, right: HostMeterAsset): boolean {
  return (
    left.url === right.url &&
    left.delivery === right.delivery &&
    (left.delivery === "native" ||
      (right.delivery !== "native" && left.readUrl === right.readUrl))
  );
}

async function discoverWav(entry: WavEntry): Promise<PcmLayout | null> {
  const unsupported = (): null => {
    if (entry.asset.delivery !== "probe")
      throw new Error("Unsupported meter format");
    return null;
  };
  const prefix = await finiteRange(entry.asset.url, 0, 12, entry.abort);
  if (fourcc(prefix.bytes) !== "RIFF" || fourcc(prefix.bytes, 8) !== "WAVE")
    return unsupported();
  const riffEnd = new DataView(prefix.bytes.buffer).getUint32(4, true) + 8;
  if (riffEnd < 12 || riffEnd > prefix.identity.total)
    throw new Error("Invalid RIFF extent");
  let offset = 12;
  let format: {
    sampleRate: number;
    channels: number;
    blockAlign: number;
  } | null = null;
  while (offset + 8 <= riffEnd) {
    const chunk = await finiteRange(
      entry.asset.readUrl,
      offset,
      8,
      entry.abort,
      prefix.identity,
    );
    const size = new DataView(chunk.bytes.buffer).getUint32(4, true);
    const body = offset + 8;
    const next = body + size + (size % 2);
    if (next > riffEnd) throw new Error("Invalid WAV chunk extent");
    const id = fourcc(chunk.bytes);
    if (id === "fmt ") {
      if (format || size < 16 || size === 17)
        throw new Error("Invalid WAV format chunk");
      const fmt = await finiteRange(
        entry.asset.readUrl,
        body,
        Math.min(size, 18),
        entry.abort,
        prefix.identity,
      );
      const view = new DataView(fmt.bytes.buffer);
      const channels = view.getUint16(2, true);
      const sampleRate = view.getUint32(4, true);
      const blockAlign = view.getUint16(12, true);
      if (
        view.getUint16(0, true) !== 1 ||
        view.getUint16(14, true) !== 16 ||
        (size !== 16 && size !== 18)
      )
        return unsupported();
      if (
        channels === 0 ||
        sampleRate === 0 ||
        blockAlign !== channels * 2 ||
        view.getUint32(8, true) !== sampleRate * blockAlign ||
        (size === 18 && view.getUint16(16, true) !== 0)
      )
        throw new Error("Processed meter WAV must be 16-bit PCM");
      format = { channels, sampleRate, blockAlign };
    } else if (id === "data") {
      if (!format || size === 0 || size % format.blockAlign !== 0)
        throw new Error("Invalid WAV data alignment");
      return {
        ...format,
        identity: prefix.identity,
        dataOffset: body,
        frames: size / format.blockAlign,
      };
    }
    offset = next;
  }
  throw new Error("Missing WAV data");
}

export type HostMeterContextBarrier = {
  closing: AudioContext | null;
};

export function createHostPlaybackMeterMonitor(options: {
  tracks: () => HostMeterTrack[];
  clock: () => HostMeterClock | null;
  contextBarrier?: HostMeterContextBarrier;
}) {
  const entries = new Map<string, MonitorEntry>();
  let context: AudioContext | null = null;
  let contextEvents: AbortController | null = null;
  const contextBarrier = options.contextBarrier ?? { closing: null };
  let resumingContext: AudioContext | null = null;
  let disposed = false;
  let unavailable = false;
  let snapshot = new Map<string, HostMeterTrack>();
  let activeRate = 1;
  let active = false;

  const releaseReader = (
    reader: NativeReader,
    kind: "released" | "failed" = "released",
  ) => {
    const state = reader.state;
    if (state.kind === "released" || state.kind === "failed") return;
    reader.state = { kind };
    const cleanup = [
      () => reader.events.abort(),
      () => {
        reader.media.volume = 0;
      },
      () => reader.media.pause(),
      () => reader.media.removeAttribute("src"),
      () => reader.media.load(),
      ...(state.kind === "bound"
        ? [
            ...state.branches.flatMap((branch) => [
              () => branch.tap.dispose(),
              () => branch.gain.disconnect(),
            ]),
            ...state.connections.map((node) => () => node.disconnect()),
            () => state.source.disconnect(),
          ]
        : []),
    ];
    for (const dispose of cleanup) {
      try {
        dispose();
      } catch {}
    }
  };
  const releaseWindow = (window: WavWindow) => {
    const assembly = window.assembly;
    if (assembly.released) return;
    assembly.released = true;
    assembly.payload = null;
    const local = window.local;
    for (const member of assembly.members) {
      member.window.abort.abort();
      member.window.history = null;
      member.window.local = null;
      if (member.entry.state.kind === "ready") {
        const windows = member.entry.state.windows;
        const index = windows.indexOf(member.window);
        if (index >= 0) windows.splice(index, 1);
      }
    }
    if (local) {
      releaseReader(local.reader);
      URL.revokeObjectURL(local.url);
    }
  };
  const retirePreparedWindows = (entry: WavEntry) => {
    if (entry.state.kind !== "ready") return;
    const windows = entry.state.windows.splice(0);
    entry.state.demand = null;
    for (const window of [...windows]) releaseWindow(window);
  };
  const invalidatePreparedRun = (reader: NativeReader) => {
    if (reader.playback !== "prepared" || reader.state.kind !== "bound") return;
    reader.state.run = null;
    reader.state.warmAfter = Infinity;
  };
  const release = (entry: MonitorEntry) => {
    if (entry.delivery === "native") releaseReader(entry.reader);
    else {
      entry.abort.abort();
      retirePreparedWindows(entry);
    }
  };
  const isCurrent = (id: string, entry: MonitorEntry) =>
    entries.get(id) === entry;
  const retire = (id: string, entry: MonitorEntry) => {
    if (!isCurrent(id, entry)) return;
    release(entry);
    entries.delete(id);
  };
  const currentTrack = (
    id: string,
    entry: MonitorEntry,
    eligible = true,
    tracks = options.tracks(),
  ) => {
    if (disposed || !options.clock() || !isCurrent(id, entry)) return null;
    const track = tracks.find((item) => item.id === id);
    return track &&
      sameAsset(track, entry.asset) &&
      (!eligible || (track.gain !== 0 && track.mediaSec !== null))
      ? track
      : null;
  };
  const retireContext = () => {
    const owned = context;
    if (!owned) return;
    context = null;
    contextEvents?.abort();
    contextEvents = null;
    resumingContext = null;
    contextBarrier.closing = owned;
    try {
      void owned.close().then(
        () => {
          if (contextBarrier.closing === owned) contextBarrier.closing = null;
        },
        () => {
          if (contextBarrier.closing === owned) unavailable = true;
        },
      );
    } catch {
      unavailable = true;
    }
  };
  const resumeContext = () => {
    const owned = context;
    if (
      !owned ||
      disposed ||
      unavailable ||
      !active ||
      owned.state !== "suspended" ||
      resumingContext === owned
    )
      return;
    resumingContext = owned;
    void owned.resume().then(
      () => {
        if (resumingContext === owned) resumingContext = null;
      },
      () => {
        if (context === owned && !disposed) unavailable = true;
        if (resumingContext === owned) resumingContext = null;
      },
    );
  };
  const ensureContext = () => {
    if (!context) {
      const Context = audioContextCtor();
      if (!Context) throw new Error("Audio context unavailable");
      context = new Context();
      const owned = context;
      contextEvents = new AbortController();
      owned.addEventListener(
        "statechange",
        () => {
          if (disposed || context !== owned || owned.state === "running")
            return;
          for (const entry of entries.values())
            if (entry.delivery === "wav") retirePreparedWindows(entry);
        },
        { signal: contextEvents.signal },
      );
    }
    resumeContext();
    return context;
  };
  const createReader = (
    current: NativeReader["current"],
    playback: NativeReader["playback"],
    channels: number[] = [],
  ): NativeReader | null => {
    const cleanup: (() => void)[] = [];
    try {
      const ctx = ensureContext();
      const media = new Audio();
      cleanup.push(
        () => media.load(),
        () => media.removeAttribute("src"),
        () => media.pause(),
        () => {
          media.volume = 0;
        },
      );
      media.volume = 0;
      media.crossOrigin = "anonymous";
      media.preload = "auto";
      const reader: NativeReader = {
        media,
        current,
        playback,
        events: new AbortController(),
        starting: false,
        state: { kind: "priming", position: null },
      };
      cleanup.push(() => reader.events.abort());
      const listen = (event: string, callback: () => void) =>
        media.addEventListener(event, callback, {
          signal: reader.events.signal,
        });
      listen("error", () => {
        if (current()) releaseReader(reader, "failed");
      });
      listen("playing", () => {
        const target = current();
        if (!target || target === "waiting") {
          syncReader(reader);
          sync();
        } else if (reader.state.kind === "priming" && reader.state.position) {
          reader.state.position.playingAt = media.currentTime;
        }
      });
      for (const event of ["pause", "ended"])
        listen(event, () => {
          if (reader.state.kind === "priming" && reader.state.position)
            reader.state.position.playingAt = null;
          else if (event === "pause" && !media.ended)
            invalidatePreparedRun(reader);
        });
      for (const event of ["waiting", "stalled"])
        listen(event, () => {
          if (!media.ended) invalidatePreparedRun(reader);
        });
      listen("seeking", () => {
        if (reader.state.kind === "priming" && reader.state.position)
          reader.state.position.seek = "pending";
        else if (reader.state.kind === "bound") {
          if (reader.playback === "synchronized") {
            reader.state.warmAfter = Infinity;
            reader.state.rawSeekProgress = "pending";
          } else {
            invalidatePreparedRun(reader);
          }
        }
      });
      listen("seeked", () => {
        if (reader.state.kind === "priming" && reader.state.position)
          reader.state.position.seek = media.currentTime;
        else if (
          reader.state.kind === "bound" &&
          reader.state.rawSeekProgress === "pending"
        )
          reader.state.rawSeekProgress = media.currentTime;
      });
      listen("timeupdate", () => {
        if (reader.state.kind !== "priming") return;
        if (reader.playback === "prepared" && ctx.state !== "running") {
          releaseReader(reader);
          sync();
          return;
        }
        const target = current();
        if (!target || target === "waiting") {
          syncReader(reader);
          sync();
          return;
        }
        const position = reader.state.position;
        if (
          !position ||
          position.playingAt === null ||
          position.seek === "pending" ||
          media.paused ||
          media.seeking ||
          media.ended ||
          !Number.isFinite(media.currentTime) ||
          media.currentTime <= position.playingAt ||
          (position.seek !== null && media.currentTime <= position.seek)
        )
          return;
        const cleanup: (() => void)[] = [];
        try {
          const source = ctx.createMediaElementSource(media);
          cleanup.push(() => source.disconnect());
          const branches: ReaderBranch[] = [];
          const connections: AudioNode[] = [];
          const splitter =
            channels.length > 1
              ? ctx.createChannelSplitter(
                  channels.reduce((sum, count) => sum + count, 0),
                )
              : null;
          if (splitter) {
            connections.push(splitter);
            cleanup.push(() => splitter.disconnect());
            source.connect(splitter);
          }
          let offset = 0;
          for (const [index, count] of (channels.length
            ? channels
            : [2]
          ).entries()) {
            const gain = ctx.createGain();
            cleanup.push(() => gain.disconnect());
            gain.gain.value = Math.fround(target.gains?.[index] ?? target.gain);
            if (splitter) {
              const merger = ctx.createChannelMerger(count);
              connections.push(merger);
              cleanup.push(() => merger.disconnect());
              for (let channel = 0; channel < count; channel++)
                splitter.connect(merger, offset + channel, channel);
              gain.channelCount = count;
              gain.channelCountMode = "explicit";
              gain.channelInterpretation = "discrete";
              merger.connect(gain);
            } else source.connect(gain);
            offset += count;
            const tap = createChannelPeakTap(ctx, gain);
            cleanup.push(() => tap.dispose());
            branches.push({ gain, tap });
          }
          const { gain, tap } = branches[0];
          media.playbackRate = target.playbackRate;
          media.volume = 1;
          reader.state = {
            kind: "bound",
            source,
            gain,
            tap,
            branches,
            connections,
            warmAfter: playback === "synchronized" ? -Infinity : Infinity,
            rawSeekProgress: null,
            run:
              playback === "prepared"
                ? {
                    observedSec: media.currentTime,
                  }
                : null,
          };
        } catch {
          releaseReader(reader, "failed");
          for (const dispose of cleanup.reverse()) {
            try {
              dispose();
            } catch {}
          }
          unavailable = true;
        }
        sync();
      });
      return reader;
    } catch {
      for (const dispose of cleanup.reverse()) {
        try {
          dispose();
        } catch {}
      }
      unavailable = true;
      return null;
    }
  };
  const syncReader = (reader: NativeReader) => {
    if (reader.state.kind === "failed" || reader.state.kind === "released")
      return;
    const target = reader.current();
    if (!target) {
      releaseReader(reader);
      return;
    }
    const { media, state } = reader;
    if (target === "waiting") {
      media.volume = 0;
      media.pause();
      if (state.kind === "priming") state.position = null;
      else state.warmAfter = Infinity;
      return;
    }
    if (state.kind === "bound") {
      if (reader.playback === "prepared") {
        if (
          !state.run ||
          context?.state !== "running" ||
          (media.paused && !media.ended) ||
          (!media.ended && media.readyState < 2) ||
          media.seeking
        ) {
          invalidatePreparedRun(reader);
          return;
        }
      }
      for (const [index, branch] of state.branches.entries()) {
        const gain = Math.fround(target.gains?.[index] ?? target.gain);
        if (
          branch.gain.gain.value !== gain ||
          media.playbackRate !== target.playbackRate
        )
          state.warmAfter = Infinity;
        branch.gain.gain.value = gain;
      }
      media.volume = 1;
    }
    media.playbackRate = target.playbackRate;
    if (media.readyState < 2) return;
    if (state.kind === "priming" && !state.position) {
      state.position = {
        playingAt: null,
        seek: media.seeking ? "pending" : null,
      };
      if (
        !media.seeking &&
        Math.abs(media.currentTime - target.localSec) > 0.08
      ) {
        media.currentTime = target.localSec;
        state.position.seek = media.seeking ? "pending" : media.currentTime;
      }
    } else if (
      state.kind === "bound" &&
      reader.playback === "synchronized" &&
      !media.seeking &&
      Math.abs(media.currentTime - target.localSec) > 0.08
    ) {
      state.warmAfter = Infinity;
      state.rawSeekProgress = "pending";
      media.currentTime = target.localSec;
      if (!media.seeking && state.rawSeekProgress === "pending")
        state.rawSeekProgress = media.currentTime;
    }
    if (
      media.paused &&
      !reader.starting &&
      !(reader.playback === "prepared" && media.ended)
    ) {
      reader.starting = true;
      if (state.kind === "bound") state.warmAfter = Infinity;
      void media
        .play()
        .catch((error: unknown) => {
          const latest = reader.current();
          if (
            !latest ||
            latest === "waiting" ||
            (error instanceof Error && error.name === "AbortError")
          )
            return;
          releaseReader(reader, "failed");
        })
        .finally(() => {
          reader.starting = false;
          const latest = reader.current();
          if (
            !latest ||
            latest === "waiting" ||
            reader.state.kind === "failed" ||
            reader.state.kind === "released"
          ) {
            syncReader(reader);
            media.volume = 0;
            media.pause();
            sync();
          }
        });
    }
    if (state.kind !== "bound") return;
    if (media.seeking) {
      state.warmAfter = Infinity;
      if (reader.playback === "synchronized") state.rawSeekProgress = "pending";
      return;
    }
    if (
      state.rawSeekProgress === "pending" ||
      (state.rawSeekProgress !== null &&
        !(media.currentTime > state.rawSeekProgress))
    )
      return;
    state.rawSeekProgress = null;
    if (
      context?.state === "running" &&
      !media.paused &&
      !reader.starting &&
      state.warmAfter === Infinity
    )
      state.warmAfter = context.currentTime + TAP_FRAMES / context.sampleRate;
  };
  const failWav = (entry: WavEntry) => {
    release(entry);
    entry.state = { kind: "failed" };
  };
  const failAssembly = (window: WavWindow) => {
    if (window.assembly.released) return;
    releaseWindow(window);
    for (const member of window.assembly.members)
      if (isCurrent(member.id, member.entry)) failWav(member.entry);
  };

  const captureWindow = (
    track: HostMeterTrack,
    layout: PcmLayout,
    window: WavWindow,
  ) => {
    const reader = window.local?.reader;
    const state = reader?.state;
    if (
      !reader ||
      !state ||
      state.kind !== "bound" ||
      !state.run ||
      !context ||
      context.state !== "running" ||
      reader.media.seeking
    ) {
      window.history = null;
      return;
    }
    const observedSec = reader.media.currentTime;
    if (!Number.isFinite(observedSec) || observedSec < state.run.observedSec) {
      invalidatePreparedRun(reader);
      window.history = null;
      return;
    }
    const previous =
      window.observed?.run === state.run
        ? window.observed.sec
        : state.run.observedSec;
    const advanced = observedSec > previous;
    state.run.observedSec = observedSec;
    window.observed = { run: state.run, sec: observedSec };
    if (state.run.warmOnProgress) {
      window.history = null;
      if (advanced) {
        state.run.warmOnProgress = false;
        state.warmAfter = context.currentTime + TAP_FRAMES / context.sampleRate;
      }
      return;
    }
    if (state.warmAfter > context.currentTime) {
      window.history = null;
      return;
    }
    const gain = Math.fround(track.gain);
    if (
      !window.history ||
      window.history.run !== state.run ||
      window.history.gain !== gain ||
      window.history.playbackRate !== activeRate
    )
      window.history = {
        run: state.run,
        gain,
        playbackRate: activeRate,
        capturedAt: -Infinity,
        blocks: [],
      };
    const history = window.history;
    history.blocks = history.blocks.filter(
      (block) => block.observedTrackSec >= track.mediaSec! - 0.08,
    );
    const stride = Math.min(
      TAP_FRAMES / context.sampleRate,
      0.08 / (2 * activeRate),
    );
    if (
      reader.media.paused ||
      reader.media.ended ||
      reader.media.readyState < 2 ||
      !advanced ||
      context.currentTime - history.capturedAt < stride
    )
      return;
    // The element position associates the analyser history approximately.
    const observedTrackSec = window.first / layout.sampleRate + observedSec;
    if (
      observedTrackSec < window.first / layout.sampleRate ||
      observedTrackSec >= window.end / layout.sampleRate
    )
      return;
    history.blocks.push({
      observedTrackSec,
      samples: new Float32Array(state.branches[window.branch].tap.read()),
    });
    history.capturedAt = context.currentTime;
    const duration = (window.end - window.first) / layout.sampleRate;
    const maxBlocks =
      Math.ceil(
        (duration / activeRate + TAP_FRAMES / context.sampleRate) / stride,
      ) + 2;
    if (history.blocks.length > maxBlocks)
      history.blocks.splice(0, history.blocks.length - maxBlocks);
  };

  const compatibleMembers = (
    track: HostMeterTrack,
    entry: WavEntry,
  ): WavMember[] => {
    if (entry.state.kind !== "ready") return [];
    const own = { id: track.id, entry, layout: entry.state.layout };
    if (own.layout.channels > 2) return [own];
    const groups: WavMember[][] = [];
    let group: WavMember[] = [];
    let channels = 0;
    for (const [id, other] of entries) {
      const target = snapshot.get(id);
      if (
        other.delivery !== "wav" ||
        other.state.kind !== "ready" ||
        !target ||
        target.gain === 0 ||
        target.mediaSec !== track.mediaSec ||
        other.state.layout.sampleRate !== own.layout.sampleRate ||
        other.state.layout.channels > 2 ||
        track.mediaSec! * own.layout.sampleRate >= other.state.layout.frames
      )
        continue;
      const layout = other.state.layout;
      if (channels + layout.channels > 32) {
        groups.push(group);
        group = [];
        channels = 0;
      }
      group.push({ id, entry: other, layout });
      channels += layout.channels;
    }
    groups.push(group);
    return (
      groups.find((members) =>
        members.some((member) => member.entry === entry),
      ) ?? [own]
    );
  };

  const prepareWindow = (
    track: HostMeterTrack,
    entry: WavEntry,
    first: number,
    turn: number,
    hop: number,
    overlap: number,
  ) => {
    const members = compatibleMembers(track, entry);
    if (!members.length) return;
    const end = Math.min(
      turn + overlap,
      ...members.map((member) => member.layout.frames),
    );
    if (
      first >= end ||
      members.some(
        (member) =>
          member.entry.state.kind !== "ready" ||
          member.entry.state.windows.length >= 2,
      )
    )
      return;
    const assembly: WavAssembly = {
      members: [],
      released: false,
      payload: null,
    };
    const abort = new AbortController();
    for (const [branch, member] of members.entries()) {
      const window: WavWindow = {
        first,
        end,
        turn,
        hop,
        overlap,
        abort,
        assembly,
        branch,
        local: null,
        history: null,
        observed: null,
      };
      assembly.members.push({ ...member, window });
      if (member.entry.state.kind === "ready")
        member.entry.state.windows.push(window);
    }
    const window = assembly.members[0].window;
    const sampleRate = members[0].layout.sampleRate;
    const channels = members.reduce(
      (sum, member) => sum + member.layout.channels,
      0,
    );
    const align = channels * 2;
    if ((end - first) * align > WINDOW_BYTES) {
      releaseWindow(window);
      return;
    }
    const current = () => {
      const tracks = options.tracks();
      const targets = assembly.members.map((member) =>
        currentTrack(member.id, member.entry, true, tracks),
      );
      if (
        assembly.released ||
        abort.signal.aborted ||
        context?.state !== "running" ||
        targets.some(
          (target) => !target || target.mediaSec !== targets[0]?.mediaSec,
        ) ||
        assembly.members.some(
          (member) =>
            member.entry.abort.signal.aborted ||
            member.entry.state.kind !== "ready" ||
            member.entry.state.layout !== member.layout ||
            !member.entry.state.windows.includes(member.window),
        )
      )
        return null;
      return targets as HostMeterTrack[];
    };
    const discardStale = () => {
      releaseWindow(window);
      for (const member of members)
        if (!currentTrack(member.id, member.entry))
          retire(member.id, member.entry);
    };
    const readMember = async (member: WavMember) => {
      try {
        return (
          await finiteRange(
            member.entry.asset.readUrl,
            member.layout.dataOffset + first * member.layout.blockAlign,
            (end - first) * member.layout.blockAlign,
            abort,
            member.layout.identity,
          )
        ).bytes;
      } catch {
        if (!assembly.released) {
          releaseWindow(window);
          if (isCurrent(member.id, member.entry)) failWav(member.entry);
          sync();
        }
        return null;
      }
    };
    const assemble = async () => {
      let payload: Uint8Array<ArrayBuffer>;
      if (members.length === 1) {
        const bytes = await readMember(members[0]);
        if (!bytes) return;
        payload = bytes;
      } else {
        assembly.payload = new Uint8Array((end - first) * align);
        let channelOffset = 0;
        for (const member of members) {
          const bytes = await readMember(member);
          if (!bytes) return;
          if (!current()) {
            discardStale();
            return;
          }
          for (let frame = 0; frame < end - first; frame++) {
            const source = frame * member.layout.blockAlign;
            assembly.payload!.set(
              bytes.subarray(source, source + member.layout.blockAlign),
              frame * align + channelOffset * 2,
            );
          }
          channelOffset += member.layout.channels;
        }
        payload = assembly.payload!;
        assembly.payload = null;
      }
      const targets = current();
      if (!targets) {
        discardStale();
        return;
      }
      const frame = targets[0].mediaSec! * sampleRate;
      if (frame >= end || frame < first - hop) {
        releaseWindow(window);
        return;
      }
      const currentFirst = Math.max(first, Math.floor(frame));
      payload = payload.subarray((currentFirst - first) * align);
      for (const member of assembly.members) member.window.first = currentFirst;
      const url = URL.createObjectURL(
        new Blob(
          [
            new Uint8Array(
              pcmWavHeader(payload.byteLength, sampleRate, channels),
            ),
            payload,
          ],
          { type: "audio/wav" },
        ),
      );
      const reader = createReader(
        () => {
          const targets = current();
          const clock = options.clock();
          if (!targets || !clock || window.local?.reader !== reader)
            return null;
          const frame = targets[0].mediaSec! * sampleRate;
          if (frame >= end || frame < window.first - hop) return null;
          return {
            localSec: 0,
            gain: targets[0].gain,
            gains: targets.map((target) => target.gain),
            playbackRate: clock.playbackRate,
          };
        },
        "prepared",
        members.map((member) => member.layout.channels),
      );
      if (!reader) {
        URL.revokeObjectURL(url);
        failAssembly(window);
        return;
      }
      for (const member of assembly.members)
        member.window.local = { url, reader };
      reader.media.src = url;
      sync();
    };
    void assemble().catch(() => failAssembly(window));
  };

  const syncWav = (track: HostMeterTrack, entry: WavEntry) => {
    if (track.mediaSec === null || track.gain === 0) {
      release(entry);
      entries.delete(track.id);
      return;
    }
    if (entry.state.kind !== "ready") return;
    if (ensureContext().state !== "running") {
      retirePreparedWindows(entry);
      return;
    }
    const expected = compatibleMembers(track, entry);
    if (
      entry.state.windows.some(
        (window) =>
          window.assembly.members.length !== expected.length ||
          window.assembly.members.some(
            (member, index) => member.entry !== expected[index].entry,
          ),
      )
    )
      retirePreparedWindows(entry);
    const { layout, windows } = entry.state;
    let discontinuity = false;
    if (context) {
      const demand = entry.state.demand;
      if (demand && track.mediaSec !== demand.mediaSec) {
        const advance = track.mediaSec - demand.mediaSec;
        const elapsed = context.currentTime - demand.contextSec;
        if (advance < 0 || advance - elapsed * demand.playbackRate > 0.08)
          discontinuity = true;
      }
      if (!demand || track.mediaSec !== demand.mediaSec)
        entry.state.demand = {
          mediaSec: track.mediaSec,
          contextSec: context.currentTime,
          playbackRate: activeRate,
        };
    }
    const frame = Math.floor(track.mediaSec * layout.sampleRate);
    if (!Number.isSafeInteger(frame) || frame < 0 || frame >= layout.frames) {
      for (const window of [...windows]) releaseWindow(window);
      windows.length = 0;
      return;
    }
    for (const window of [...windows]) {
      const reader = window.local?.reader;
      if (
        frame >= window.end ||
        frame < window.first - window.hop ||
        reader?.state.kind === "released" ||
        (reader?.state.kind === "bound" && !reader.state.run)
      ) {
        releaseWindow(window);
      }
    }
    if (discontinuity) {
      const retained = windows.find(
        (window) => frame >= window.first && frame < window.end,
      );
      if (retained) {
        for (const member of retained.assembly.members) {
          member.window.history = null;
          member.window.observed = null;
          if (member.entry.state.kind === "ready")
            member.entry.state.demand = entry.state.demand;
        }
        const state = retained.local?.reader.state;
        if (state?.kind === "bound") {
          state.run = {
            observedSec: retained.local!.reader.media.currentTime,
            warmOnProgress: true,
          };
          state.warmAfter = Infinity;
        }
        for (const window of [...windows]) {
          if (window !== retained) releaseWindow(window);
        }
        prepareWindow(
          track,
          entry,
          frame,
          frame + retained.hop,
          retained.hop,
          retained.overlap,
        );
      }
    }
    if (
      !windows.some((window) => frame >= window.first && frame < window.end)
    ) {
      for (const window of [...windows]) releaseWindow(window);
      windows.length = 0;
      const tapSourceFrames =
        (layout.sampleRate * activeRate * TAP_FRAMES) /
        ensureContext().sampleRate;
      const blockAlign = compatibleMembers(track, entry).reduce(
        (sum, member) => sum + member.layout.blockAlign,
        0,
      );
      const maxFrames = Math.floor(WINDOW_BYTES / blockAlign);
      const overlap = Math.min(
        Math.ceil(tapSourceFrames * OVERLAP_TAPS),
        Math.floor(maxFrames / 4),
      );
      const hop = Math.min(
        Math.ceil(tapSourceFrames * WINDOW_TAPS),
        maxFrames - 2 * overlap,
      );
      const base = Math.floor(frame / hop) * hop;
      prepareWindow(
        track,
        entry,
        Math.max(0, base - overlap),
        base + hop,
        hop,
        overlap,
      );
      const forwardFirst = base + Math.ceil(hop / 2) - overlap;
      if (forwardFirst > frame)
        prepareWindow(
          track,
          entry,
          forwardFirst,
          base + hop + Math.ceil(hop / 2),
          hop,
          overlap,
        );
    }
    const current = windows.find(
      (window) => frame >= window.first && frame < window.end,
    );
    if (
      current &&
      windows.length === 1 &&
      frame >= current.turn - current.hop / 2 &&
      current.turn < layout.frames
    )
      prepareWindow(
        track,
        entry,
        current.turn - current.overlap,
        current.turn + current.hop,
        current.hop,
        current.overlap,
      );
    for (const window of [...windows]) {
      if (!window.local) continue;
      if (window.local.reader.state.kind === "failed") {
        failAssembly(window);
        return;
      }
      syncReader(window.local.reader);
      const state = window.local.reader.state;
      if (state.kind === "released" || (state.kind === "bound" && !state.run)) {
        releaseWindow(window);
        continue;
      }
      captureWindow(track, layout, window);
    }
  };

  const synchronize = () => {
    const clock = disposed ? null : options.clock();
    if (!clock) {
      active = false;
      for (const entry of entries.values()) release(entry);
      entries.clear();
      snapshot.clear();
      retireContext();
      return;
    }
    if (contextBarrier.closing) return;
    active = true;
    resumeContext();
    const tracks = options.tracks();
    snapshot = new Map(tracks.map((track) => [track.id, track]));
    activeRate = clock.playbackRate;
    for (const [id, entry] of entries) {
      const track = snapshot.get(id);
      if (
        !track ||
        (entry.delivery === "native" &&
          entry.reader.state.kind === "released") ||
        !sameAsset(track, entry.asset)
      ) {
        release(entry);
        entries.delete(id);
      }
    }
    for (const track of tracks) {
      const entry = entries.get(track.id);
      if (!entry) continue;
      if (entry.delivery === "native") {
        syncReader(entry.reader);
        if (entry.reader.state.kind === "released") entries.delete(track.id);
      } else syncWav(track, entry);
    }
  };
  const sync = () => {
    try {
      synchronize();
    } catch {
      unavailable = true;
    }
  };
  const createNativeEntry = (track: HostMeterTrack): MonitorEntry | null => {
    const reader = createReader(() => {
      const latest = currentTrack(track.id, entry, false);
      const clock = options.clock();
      if (!latest || !clock || entry.reader !== reader) return null;
      if (latest.gain === 0 || latest.mediaSec === null || latest.mediaSec < 0)
        return reader?.state.kind === "bound" ? "waiting" : null;
      return {
        localSec: latest.mediaSec,
        gain: latest.gain,
        playbackRate: clock.playbackRate,
      };
    }, "synchronized");
    if (!reader) return null;
    const entry: Extract<MonitorEntry, { delivery: "native" }> = {
      delivery: "native",
      asset: track,
      reader,
    };
    entries.set(track.id, entry);
    try {
      reader.media.src = track.url;
    } catch {
      unavailable = true;
      releaseReader(reader, "failed");
    }
    return entry;
  };
  const createEntry = (track: HostMeterTrack): MonitorEntry | null => {
    if (track.delivery === "native") return createNativeEntry(track);
    const entry: WavEntry = {
      delivery: "wav",
      asset: track,
      abort: new AbortController(),
      state: { kind: "opening" },
    };
    entries.set(track.id, entry);
    void discoverWav(entry)
      .then((layout) => {
        if (!currentTrack(track.id, entry) || entry.abort.signal.aborted) {
          retire(track.id, entry);
          return;
        }
        if (layout === null) {
          entry.abort.abort();
          if (!createNativeEntry(track)) failWav(entry);
          sync();
          return;
        }
        entry.state = {
          kind: "ready",
          layout,
          windows: [],
          demand: null,
        };
        sync();
      })
      .catch(() => {
        if (isCurrent(track.id, entry)) failWav(entry);
      });
    return entry;
  };

  sync();
  return {
    sync,
    read(trackId: string): ArrayLike<number> | null {
      if (disposed || !options.clock()) {
        if (active) sync();
        return null;
      }
      if (!active || snapshot.get(trackId)?.delivery !== "native") sync();
      const track = snapshot.get(trackId);
      if (!track) return null;
      if (track.gain === 0 || track.mediaSec === null) return SILENCE;
      if (unavailable || contextBarrier.closing) return null;
      try {
        if (track.delivery !== "native")
          for (const target of snapshot.values())
            if (
              target.delivery !== "native" &&
              target.gain !== 0 &&
              target.mediaSec !== null &&
              !entries.has(target.id)
            )
              createEntry(target);
        const entry = entries.get(trackId) ?? createEntry(track);
        if (!entry) return null;
        if (entry.delivery === "wav") {
          if (entry.state.kind !== "ready") return null;
          let selected: {
            observedTrackSec: number;
            samples: Float32Array;
          } | null = null;
          for (const window of entry.state.windows) {
            const history = window.history;
            if (
              !history ||
              window.local?.reader.state.kind !== "bound" ||
              window.local.reader.state.run !== history.run ||
              history.gain !== Math.fround(track.gain) ||
              history.playbackRate !== activeRate
            )
              continue;
            for (let index = history.blocks.length - 1; index >= 0; index--) {
              const block = history.blocks[index];
              if (block.observedTrackSec > track.mediaSec) continue;
              if (
                track.mediaSec - block.observedTrackSec <= 0.08 &&
                (!selected ||
                  block.observedTrackSec > selected.observedTrackSec)
              )
                selected = block;
              break;
            }
          }
          return selected?.samples ?? null;
        }
        const reader = entry.reader;
        if (
          !reader ||
          reader.state.kind !== "bound" ||
          reader.media.paused ||
          reader.media.seeking ||
          reader.media.readyState < 2 ||
          context?.state !== "running" ||
          reader.state.warmAfter > context.currentTime
        )
          return null;
        const target = reader.current();
        if (
          !target ||
          target === "waiting" ||
          Math.abs(reader.media.currentTime - target.localSec) > 0.08
        )
          return null;
        return reader.state.tap.read();
      } catch {
        return null;
      }
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) release(entry);
      entries.clear();
      retireContext();
    },
  };
}
