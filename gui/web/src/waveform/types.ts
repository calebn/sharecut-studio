/**
 * Shared types of the waveform data layer (`docs/waveform.md`). Bins are
 * `i16 min, i16 max, i16 rms` triples, exactly as the server sends them.
 */

/** Which media a status poll lists: raw (track / source) or rendered stems. */
export type WaveformKind = "raw" | "stem";

/** One media file the viewer draws: `track:<id>`, `source:<id>` or `stem:<id>`. */
export type MediaRef =
  | `track:${string}`
  | `source:${string}`
  | `stem:${string}`;

export type PyramidLevel = { spp: number; bins: number };

/** A ready pyramid, as `GET /api/waveform/status` describes it. */
export type PyramidMeta = {
  key: string;
  sample_rate: number;
  channels: number;
  total_frames: number;
  base_spp: number;
  level_factor: number;
  bins_per_tile: number;
  levels: PyramidLevel[];
};

export type StatusEntry =
  | ({ status: "ready" } & PyramidMeta)
  | { status: "generating" }
  | { status: "unavailable"; reason?: string };

export type ReadyEntry = Extract<StatusEntry, { status: "ready" }>;

export type WaveformStatus = {
  format_version: number;
  media: Record<string, StatusEntry>;
};

/**
 * Per-column envelope in -1..1 (`rms` 0..1). `has[c]` is 0 where no data
 * covers column `c`; such columns are drawn empty.
 */
export type Envelope = {
  cols: number;
  min: Float32Array;
  max: Float32Array;
  rms: Float32Array;
  has: Uint8Array;
};

/** How a render tile is reduced: pyramid bins, host PCM, or PCM as a line. */
export type RasterMode = "pyramid" | "pcm" | "line";

/** Straight-alpha RGBA, 0..1 per channel. */
export type Rgba = Float32Array;

/** The two-tone look: RMS body in `core`, peak envelope in `edge`. */
export type WaveformStyle = { core: Rgba; edge: Rgba };

/** Where a raster job's envelope comes from. */
export type RasterSource =
  | {
      kind: "pyramid";
      /** Bins of one level from `binStart`; missing bins have `rms = -1`. */
      bins: Int16Array;
      binStart: number;
      spp: number;
    }
  | {
      kind: "pcm";
      /** Per-frame `(min, max)` pairs from frame `pcmStart`. */
      pcm: Int16Array;
      pcmStart: number;
    };

/** One render tile to rasterize (S5 / S6). */
export type RasterJob = {
  cols: number;
  rows: number;
  mode: RasterMode;
  /** Media frame at the tile's left edge (may be fractional). */
  frameStart: number;
  /** Media frames per device column. */
  sppDev: number;
  ampZoom: number;
  core: Rgba;
  edge: Rgba;
  source: RasterSource;
};

export type RasterBackend = "webgl2" | "cpu-worker" | "none";

/** True for a ready entry. */
export function isReady(
  entry: StatusEntry | null | undefined,
): entry is ReadyEntry {
  return entry?.status === "ready";
}

/** Status kind that lists `ref`. */
export function refKind(ref: string): WaveformKind {
  return ref.startsWith("stem:") ? "stem" : "raw";
}
