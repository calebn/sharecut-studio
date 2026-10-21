export interface VolumePoint {
  readonly time: number;
  readonly value: number;
}

export interface ClipFade {
  readonly timelineStartSec: number;
  readonly timelineEndSec: number;
  readonly fadeInSec: number;
  readonly fadeOutSec: number;
  /** Source second the clip starts at; with `mute`, places the mutes on the timeline. */
  readonly sourceStartSec?: number;
  readonly mute?: readonly MuteSpan[];
  /** Off-speaker (automatic) mute spans in source seconds; see `automaticGainAt`. */
  readonly automaticMute?: readonly AutomaticMuteSpan[];
}

/** One automatic off-speaker mute in source seconds: `SourceMuteEnvelope` in `engines/audio.py`. */
export interface AutomaticMuteSpan {
  readonly start: number;
  readonly end: number;
  readonly fadeOutSec: number;
  readonly fadeInSec: number;
}

export interface AutomaticMuteRegionLike {
  readonly start_s: number;
  readonly end_s: number;
  readonly fade_out_ms?: number;
  readonly fade_in_ms?: number;
}

/** One mute-in-place span in source seconds: `MuteEnvelope` in `engines/audio.py`. */
export interface MuteSpan {
  readonly start: number;
  readonly end: number;
  readonly fadeOutSec: number;
  readonly fadeInSec: number;
  /** Linear: 0 for a mute, 10**(dB/20) for a lowered span. */
  readonly gain: number;
}

export interface MuteRegionLike {
  readonly start_s: number;
  readonly end_s: number;
  readonly fade_out_ms?: number;
  readonly fade_in_ms?: number;
  readonly gain_db?: number | null;
}

/** The server's default `MUTE_FADE_MS`. */
const MUTE_FADE_MS = 5;

/**
 * A clip's mute regions as the render's non-overlapping spans (`_envelopes` in
 * `engines/mute_regions.py`): same-gain overlaps merge, the quieter span keeps an overlap.
 */
export function muteSpansOf(
  regions: readonly MuteRegionLike[] | undefined,
): MuteSpan[] {
  const out: MuteSpan[] = [];
  const sorted = [...(regions ?? [])].sort(
    (a, b) => a.start_s - b.start_s || a.end_s - b.end_s,
  );
  for (const region of sorted) {
    let span: MuteSpan = {
      start: region.start_s,
      end: region.end_s,
      fadeOutSec: (region.fade_out_ms ?? MUTE_FADE_MS) / 1000,
      fadeInSec: (region.fade_in_ms ?? MUTE_FADE_MS) / 1000,
      gain:
        region.gain_db == null ? 0 : Math.pow(10, (region.gain_db ?? 0) / 20),
    };
    const prev = out[out.length - 1];
    if (prev && span.start <= prev.end + 1e-6) {
      if (span.gain === prev.gain) {
        if (span.end > prev.end)
          out[out.length - 1] = {
            ...prev,
            end: span.end,
            fadeInSec: span.fadeInSec,
          };
        continue;
      }
      if (span.gain < prev.gain) {
        if (span.start > prev.start + 1e-9) {
          out[out.length - 1] = { ...prev, end: span.start };
          out.push(span);
        } else out[out.length - 1] = span;
        continue;
      }
      if (span.end > prev.end + 1e-9) {
        span = { ...span, start: prev.end };
        out.push(span);
      }
      continue;
    }
    out.push(span);
  }
  return out;
}

/** A clip's off-speaker regions as spans (the model's fades default to `MUTE_FADE_MS`). */
export function automaticSpansOf(
  regions: readonly AutomaticMuteRegionLike[] | undefined,
): AutomaticMuteSpan[] {
  return (regions ?? []).map((region) => ({
    start: region.start_s,
    end: region.end_s,
    fadeOutSec: (region.fade_out_ms ?? MUTE_FADE_MS) / 1000,
    fadeInSec: (region.fade_in_ms ?? MUTE_FADE_MS) / 1000,
  }));
}

/**
 * The off-speaker gain at source second `sec`: `automatic_gain_expression` in `engines/ffmpeg.py`.
 * Each region ramps down over its first fade and up over its last, silent between; fades that
 * overlap make a hard mute across the region. Regions combine by `min`, and are independent of
 * the ordinary mute spans (the render multiplies the two).
 */
export function automaticGainAt(
  spans: readonly AutomaticMuteSpan[],
  sec: number,
): number {
  let gain = 1;
  for (const { start, end, fadeOutSec, fadeInSec } of spans) {
    let fall = start + fadeOutSec;
    let rise = end - fadeInSec;
    if (fall > rise) {
      fall = start;
      rise = end;
    }
    let value = 1;
    if (sec >= start && sec < end) {
      if (sec < fall) value = (fall - sec) / (fall - start);
      else if (sec < rise) value = 0;
      else value = (sec - rise) / (end - rise);
    }
    gain = Math.min(gain, value);
  }
  return gain;
}

/**
 * The mute gain at source second `sec`: what `mute_gain_expression` renders. Its interval tree
 * reads only the latest span that has started, so where spans abut the later one wins.
 */
export function muteGainAt(spans: readonly MuteSpan[], sec: number): number {
  let span: MuteSpan | undefined;
  for (const candidate of spans) if (candidate.start <= sec) span = candidate;
  if (!span || sec > span.end) return 1;
  const { start, end, fadeOutSec, fadeInSec, gain: floor } = span;
  const lift = 1 - floor;
  // Sample counts in the render, so a fade as long as the span still ramps.
  if (fadeOutSec + fadeInSec > end - start + 1e-6) return sec < end ? floor : 1;
  if (fadeOutSec > 0 && sec <= start + fadeOutSec)
    return 1 - (lift * (sec - start)) / fadeOutSec;
  if (sec <= end - fadeInSec) return floor;
  return fadeInSec > 0
    ? floor + (lift * (sec - (end - fadeInSec))) / fadeInSec
    : 1;
}

/** The mute at timeline `sec` of a clip that carries spans. */
function clipMuteGainAt(clip: ClipFade, sec: number): number {
  if (!clip.mute?.length) return 1;
  return muteGainAt(
    clip.mute,
    (clip.sourceStartSec ?? 0) + sec - clip.timelineStartSec,
  );
}

/** The off-speaker gain at timeline `sec` of a clip that carries regions. */
function clipAutomaticGainAt(clip: ClipFade, sec: number): number {
  if (!clip.automaticMute?.length) return 1;
  return automaticGainAt(
    clip.automaticMute,
    (clip.sourceStartSec ?? 0) + sec - clip.timelineStartSec,
  );
}

/** What `fade_duration` in `engines/audio.py` renders: no fade longer than half its clip. */
export function renderedFadeSec(clipSec: number, requestedSec: number): number {
  return Math.min(requestedSec, Math.max(clipSec * 0.5, 0.001));
}

/** The volume envelope at `sec`, the line `FFmpegEngine._volume_expression` renders. */
export function envelopeGainAt(
  points: readonly VolumePoint[],
  sec: number,
): number {
  const first = points[0];
  if (!first) return 1;
  if (points.length === 1 || sec < first.time) return first.value;
  for (let index = 1; index < points.length; index++) {
    const left = points[index - 1]!;
    const right = points[index]!;
    if (right.time === left.time || sec >= right.time) continue;
    return (
      left.value +
      ((sec - left.time) * (right.value - left.value)) /
        (right.time - left.time)
    );
  }
  return points[points.length - 1]!.value;
}

/** The clip's edge fades at `sec`: the two ramps `afade` renders, in and out. */
export function fadeGainAt(clip: ClipFade, sec: number): number {
  const length = clip.timelineEndSec - clip.timelineStartSec;
  const fadeIn =
    clip.fadeInSec > 0 ? renderedFadeSec(length, clip.fadeInSec) : 0;
  const fadeOut =
    clip.fadeOutSec > 0 ? renderedFadeSec(length, clip.fadeOutSec) : 0;
  return Math.max(
    0,
    Math.min(
      1,
      fadeIn > 0 ? (sec - clip.timelineStartSec) / fadeIn : 1,
      fadeOut > 0 ? (clip.timelineEndSec - sec) / fadeOut : 1,
    ),
  );
}

/** One track's gain at `sec`: the envelope times the clip's edge fade (fades ride the envelope). */
export function effectiveGainAt(
  points: readonly VolumePoint[],
  clip: ClipFade,
  sec: number,
): number {
  return (
    envelopeGainAt(points, sec) *
    fadeGainAt(clip, sec) *
    clipMuteGainAt(clip, sec) *
    clipAutomaticGainAt(clip, sec)
  );
}

/** A step in the envelope holds its old level to this long before it jumps. */
const STEP_HOLD_SEC = 1e-6;

/** Inside a fade the product of two lines is a curve; a ramp every step follows it. */
const FADE_STEP_SEC = 0.01;

/**
 * The times in `(fromSec, toSec)` where the effective gain changes slope or steps, so linear ramps
 * between them (and the two ends) follow it exactly.
 */
export function gainBreakpoints(
  points: readonly VolumePoint[],
  clip: ClipFade,
  fromSec: number,
  toSec: number,
): number[] {
  const length = clip.timelineEndSec - clip.timelineStartSec;
  const fadeIn =
    clip.fadeInSec > 0 ? renderedFadeSec(length, clip.fadeInSec) : 0;
  const fadeOut =
    clip.fadeOutSec > 0 ? renderedFadeSec(length, clip.fadeOutSec) : 0;
  const times = [
    clip.timelineStartSec + fadeIn,
    clip.timelineEndSec - fadeOut,
    ...points.map((point) => point.time),
    ...points
      .filter((point, index) => points[index + 1]?.time === point.time)
      .map((point) => point.time - STEP_HOLD_SEC),
  ];
  const ramps: (readonly [number, number])[] = [
    [clip.timelineStartSec, clip.timelineStartSec + fadeIn],
    [clip.timelineEndSec - fadeOut, clip.timelineEndSec],
  ];
  const shift = clip.timelineStartSec - (clip.sourceStartSec ?? 0);
  for (const span of clip.mute ?? []) {
    const edges = [
      span.start,
      span.start + span.fadeOutSec,
      span.end - span.fadeInSec,
      span.end,
    ].map((at) => at + shift);
    times.push(
      ...edges,
      edges[0]! - STEP_HOLD_SEC,
      edges[3]! - STEP_HOLD_SEC,
      edges[3]! + STEP_HOLD_SEC,
    );
    ramps.push([edges[0]!, edges[1]!], [edges[2]!, edges[3]!]);
  }
  for (const span of clip.automaticMute ?? []) {
    const edges = [
      span.start,
      span.start + span.fadeOutSec,
      span.end - span.fadeInSec,
      span.end,
    ].map((at) => at + shift);
    times.push(
      ...edges,
      edges[0]! - STEP_HOLD_SEC,
      edges[3]! - STEP_HOLD_SEC,
      edges[3]! + STEP_HOLD_SEC,
    );
    ramps.push([edges[0]!, edges[1]!], [edges[2]!, edges[3]!]);
  }
  for (const [from, to] of ramps)
    for (let at = from + FADE_STEP_SEC; at < to; at += FADE_STEP_SEC)
      times.push(at);
  if (fadeIn > 0 && fadeOut > 0)
    times.push(
      (fadeIn * clip.timelineEndSec + fadeOut * clip.timelineStartSec) /
        (fadeIn + fadeOut),
    );
  return times
    .filter((time) => time > fromSec && time < toSec)
    .sort((a, b) => a - b);
}
