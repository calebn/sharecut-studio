import {
  automaticSpansOf,
  type ClipFade,
  effectiveGainAt,
  gainBreakpoints,
  muteSpansOf,
  renderedFadeSec,
  type VolumePoint,
} from "../audio/gainCurve";
import {
  clipIdsBeforeCut,
  isCrossfadeJoin,
  isCutJoin,
} from "../edit/joinRender";
import type { ClipRow } from "../types/project";

export interface ClipGainPoint {
  readonly time: number;
  readonly gain: number;
}

export interface ClipGainDip {
  readonly clipId: string;
  readonly points: readonly ClipGainPoint[];
}

function dipOver(
  volume: readonly VolumePoint[],
  fade: ClipFade,
  clipId: string,
  from: number,
  to: number,
): ClipGainDip | null {
  if (to <= from) return null;
  const times = [from, ...gainBreakpoints(volume, fade, from, to), to];
  return {
    clipId,
    points: times.map((time) => ({
      time,
      gain: effectiveGainAt(volume, fade, time),
    })),
  };
}

// A crossfade join is skipped: the render replaces both edge fades there with the overlap's blend.
export function clipGainDips(
  clips: readonly ClipRow[],
  volume: readonly VolumePoint[],
): ClipGainDip[] {
  const beforeCut = clipIdsBeforeCut([...clips]);
  const out: ClipGainDip[] = [];
  for (const clip of clips) {
    const crossfadeIn = isCrossfadeJoin(clip);
    const fadeInSec =
      isCutJoin(clip) || crossfadeIn ? 0 : Math.max(0, clip.fade_in_ms) / 1000;
    const crossfadeOut = clips.some(
      (other) => other.join_left_clip_id === clip.id && isCrossfadeJoin(other),
    );
    const fadeOutSec =
      beforeCut.has(clip.id) || crossfadeOut
        ? 0
        : Math.max(0, clip.fade_out_ms) / 1000;
    const fade: ClipFade = {
      timelineStartSec: clip.timeline_start,
      timelineEndSec: clip.timeline_end,
      fadeInSec,
      fadeOutSec,
      sourceStartSec: clip.source_start,
      mute: muteSpansOf([
        ...(clip.mute_regions ?? []),
        ...(clip.ignored_word_regions ?? []),
      ]),
      automaticMute: automaticSpansOf(clip.off_speaker_mute_regions),
    };
    const length = clip.timeline_end - clip.timeline_start;
    const regions: [number, number][] = [];
    if (fadeInSec > 0)
      regions.push([
        clip.timeline_start,
        clip.timeline_start + renderedFadeSec(length, fadeInSec),
      ]);
    if (fadeOutSec > 0)
      regions.push([
        clip.timeline_end - renderedFadeSec(length, fadeOutSec),
        clip.timeline_end,
      ]);
    const shift = clip.timeline_start - clip.source_start;
    for (const span of [...(fade.mute ?? []), ...(fade.automaticMute ?? [])])
      regions.push([
        Math.max(clip.timeline_start, span.start + shift),
        Math.min(clip.timeline_end, span.end + shift),
      ]);
    for (const [from, to] of regions) {
      const dip = dipOver(volume, fade, clip.id, from, to);
      if (dip) out.push(dip);
    }
  }
  return out;
}
