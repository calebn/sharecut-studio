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
  blendsIn,
  clipIdsBeforeBlend,
  clipIdsBeforeCut,
  isCutJoin,
} from "../edit/joinRender";
import type { ClipRow } from "../types/project";
import { clipVirtualPieces } from "../utils/clipTiming";

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

export function clipGainDips(
  clips: readonly ClipRow[],
  volume: readonly VolumePoint[],
): ClipGainDip[] {
  const beforeCut = clipIdsBeforeCut(clips);
  const blendedLeft = clipIdsBeforeBlend(clips);
  const out: ClipGainDip[] = [];
  for (const clip of clips) {
    const crossfadeIn = blendsIn(clip);
    const fadeInSec =
      isCutJoin(clip) || crossfadeIn ? 0 : Math.max(0, clip.fade_in_ms) / 1000;
    const crossfadeOut = blendedLeft.has(clip.id);
    const fadeOutSec =
      beforeCut.has(clip.id) || crossfadeOut
        ? 0
        : Math.max(0, clip.fade_out_ms) / 1000;
    const mute = muteSpansOf([
      ...(clip.mute_regions ?? []),
      ...(clip.ignored_word_regions ?? []),
    ]);
    const automaticMute = automaticSpansOf(clip.off_speaker_mute_regions);
    const parts = clip.timing
      ? clipVirtualPieces(clip).map((piece, i, all) => ({
          start: piece.tlA,
          end: piece.tlA + (piece.srcB - piece.srcA),
          sourceStart: piece.srcA,
          fadeIn: i === 0 ? fadeInSec : 0,
          fadeOut: i === all.length - 1 ? fadeOutSec : 0,
        }))
      : [
          {
            start: clip.timeline_start,
            end: clip.timeline_end,
            sourceStart: clip.source_start,
            fadeIn: fadeInSec,
            fadeOut: fadeOutSec,
          },
        ];
    for (const part of parts) {
      const fade: ClipFade = {
        timelineStartSec: part.start,
        timelineEndSec: part.end,
        fadeInSec: part.fadeIn,
        fadeOutSec: part.fadeOut,
        fadeInCurve: clip.fade_in_curve,
        fadeOutCurve: clip.fade_out_curve,
        sourceStartSec: part.sourceStart,
        mute,
        automaticMute,
      };
      const length = part.end - part.start;
      const regions: [number, number][] = [];
      if (part.fadeIn > 0)
        regions.push([
          part.start,
          part.start + renderedFadeSec(length, part.fadeIn),
        ]);
      if (part.fadeOut > 0)
        regions.push([
          part.end - renderedFadeSec(length, part.fadeOut),
          part.end,
        ]);
      const shift = part.start - part.sourceStart;
      for (const span of [...mute, ...automaticMute])
        regions.push([
          Math.max(part.start, span.start + shift),
          Math.min(part.end, span.end + shift),
        ]);
      for (const [from, to] of regions) {
        const dip = dipOver(volume, fade, clip.id, from, to);
        if (dip) out.push(dip);
      }
    }
  }
  return out;
}
