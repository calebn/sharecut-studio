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
 * `edits/mute_regions.py`): same-gain overlaps merge, the quieter span keeps an overlap.
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

/** The mute spans at source second `sec`: the gain `mute_gain_expression` renders. */
export function muteGainAt(spans: readonly MuteSpan[], sec: number): number {
  let gain = 1;
  for (const span of spans) {
    if (sec < span.start || sec > span.end) continue;
    const { start, end, fadeOutSec, fadeInSec, gain: floor } = span;
    const lift = 1 - floor;
    if (fadeOutSec + fadeInSec > end - start) {
      if (sec < end) gain *= floor;
    } else if (fadeOutSec > 0 && sec <= start + fadeOutSec)
      gain *= 1 - (lift * (sec - start)) / fadeOutSec;
    else if (sec <= end - fadeInSec) gain *= floor;
    else if (fadeInSec > 0)
      gain *= floor + (lift * (sec - (end - fadeInSec))) / fadeInSec;
  }
  return gain;
}

/** The mute at timeline `sec` of a clip that carries spans. */
function clipMuteGainAt(clip: ClipFade, sec: number): number {
  if (!clip.mute?.length) return 1;
  return muteGainAt(
    clip.mute,
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
    clipMuteGainAt(clip, sec)
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
  for (const span of clip.mute ?? []) {
    const shift = clip.timelineStartSec - (clip.sourceStartSec ?? 0);
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
  }
  for (const [from, to] of [
    [clip.timelineStartSec, clip.timelineStartSec + fadeIn],
    [clip.timelineEndSec - fadeOut, clip.timelineEndSec],
  ] as const)
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
