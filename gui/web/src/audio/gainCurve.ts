export interface VolumePoint {
  readonly time: number;
  readonly value: number;
}

export interface ClipFade {
  readonly timelineStartSec: number;
  readonly timelineEndSec: number;
  readonly fadeInSec: number;
  readonly fadeOutSec: number;
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
  return envelopeGainAt(points, sec) * fadeGainAt(clip, sec);
}

/** Inside a fade the product of two lines is a curve; a ramp every step follows it. */
const FADE_STEP_SEC = 0.01;

/**
 * The times in `(fromSec, toSec)` where the effective gain changes slope, so linear ramps
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
  ];
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
