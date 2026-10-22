import {
  clipIdsBeforeCut,
  isCrossfadeJoin,
  isCutJoin,
} from "../edit/joinRender";
import { DocumentCommand } from "../types/documentCommands.generated";
import type { ClipRow, ProjectView } from "../types/project";
import { originTrackId } from "../utils/timebase";
import {
  type AutomaticMuteSpan,
  automaticSpansOf,
  type MuteSpan,
  muteSpansOf,
  type VolumePoint,
} from "./gainCurve";
import { placeLikeRender } from "./renderClock";

export interface ProxyArtifactManifest {
  readonly hash: string;
  readonly chunk_sec: number;
  readonly overlap_ms: number;
  readonly chunk_count: number;
  readonly duration_sec: number;
  readonly urls: readonly string[];
}

export interface ProxyClipBasis {
  readonly track_id: string;
  readonly origin_track_id: string;
  readonly source_id: string | null;
  readonly source_start: number;
  readonly source_end: number;
  readonly timeline_start: number;
  readonly timeline_end: number;
}

export interface ProxyProjectBasis {
  readonly history_head_id: string;
  readonly render_hashes: Readonly<Record<string, string>>;
  readonly clips: Readonly<Record<string, ProxyClipBasis>>;
}

export interface ProxyManifest {
  readonly revision: string;
  readonly project_basis: ProxyProjectBasis;
  readonly tracks: Readonly<Record<string, ProxyArtifactManifest>>;
  readonly artifacts: Readonly<Record<string, ProxyArtifactManifest>>;
  readonly occurrences: Readonly<
    Record<
      string,
      { readonly artifactId: string; readonly outputTrackId: string }
    >
  >;
}

export type ImmutableChunkRef = Readonly<{
  kind: "track" | "artifact";
  artifactId: string;
  hash: string;
  index: number;
  url: string;
}>;

export interface ClipEnvelope {
  readonly volume: readonly VolumePoint[];
  readonly timelineStartSec: number;
  readonly timelineEndSec: number;
  readonly sourceStartSec: number;
  /** The clip's mute-in-place spans (source seconds); room-tone fills are not played. */
  readonly mute: readonly MuteSpan[];
  /** Off-speaker mutes (source seconds); an occurrence proxy has them baked in. */
  readonly automaticMute: readonly AutomaticMuteSpan[];
  readonly fadeInSec: number;
  readonly fadeOutSec: number;
  readonly gainCurve: "linear" | "equalPower";
}

export interface ScheduledSlice {
  readonly chunk: ImmutableChunkRef;
  readonly outputTrackId: string;
  readonly bufferOffsetSec: number;
  readonly durationSec: number;
  readonly whenTimelineSec: number;
  readonly envelope: ClipEnvelope;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid proxy manifest");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("Invalid proxy manifest string");
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("Invalid proxy manifest geometry");
  return value;
}

function mapValues<T>(
  value: unknown,
  parse: (value: unknown, key: string) => T,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record(value)).map(([key, item]) => [
      text(key),
      parse(item, key),
    ]),
  );
}

function parseArtifact(value: unknown): ProxyArtifactManifest {
  const raw = record(value);
  const hash = text(raw.hash);
  if (!/^(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(hash))
    throw new Error("Invalid proxy artifact hash");
  const chunk_sec = number(raw.chunk_sec);
  const overlap_ms = number(raw.overlap_ms);
  const chunk_count = number(raw.chunk_count);
  const duration_sec = number(raw.duration_sec);
  if (
    chunk_sec <= 0 ||
    !Number.isSafeInteger(chunk_count) ||
    !Array.isArray(raw.urls) ||
    raw.urls.length !== chunk_count
  )
    throw new Error("Invalid proxy chunk descriptor");
  return {
    hash,
    chunk_sec,
    overlap_ms,
    chunk_count,
    duration_sec,
    urls: raw.urls.map(text),
  };
}

/** Parse network and persisted data before it can authorize playback. */
export function parseProxyManifest(value: unknown): ProxyManifest {
  const raw = record(value);
  const basis = record(raw.project_basis);
  const project_basis: ProxyProjectBasis = {
    history_head_id: text(basis.history_head_id),
    render_hashes: mapValues(basis.render_hashes, text),
    clips: mapValues(basis.clips, (value) => {
      const clip = record(value);
      const source_start = number(clip.source_start);
      const source_end = number(clip.source_end);
      const timeline_start = number(clip.timeline_start);
      const timeline_end = number(clip.timeline_end);
      if (source_end < source_start || timeline_end < timeline_start)
        throw new Error("Invalid proxy clip bounds");
      return {
        track_id: text(clip.track_id),
        origin_track_id: text(clip.origin_track_id),
        source_id: clip.source_id === null ? null : text(clip.source_id),
        source_start,
        source_end,
        timeline_start,
        timeline_end,
      };
    }),
  };
  const tracks = mapValues(raw.tracks, parseArtifact);
  const artifacts = mapValues(raw.artifacts, (value, id) => {
    const artifact = parseArtifact(value);
    if (id !== artifact.hash || id.length !== 64)
      throw new Error("Invalid occurrence artifact identity");
    return artifact;
  });
  const occurrences = mapValues(raw.occurrences, (value, id) => {
    const binding = record(value);
    const artifactId = text(binding.artifactId);
    const outputTrackId = text(binding.outputTrackId);
    if (!artifacts[artifactId] || !project_basis.clips[id])
      throw new Error("Invalid proxy occurrence binding");
    return { artifactId, outputTrackId };
  });
  return {
    revision: text(raw.revision),
    project_basis,
    tracks,
    artifacts,
    occurrences,
  };
}

export function projectProxyBasis(project: ProjectView): ProxyProjectBasis {
  const clips: Record<string, ProxyClipBasis> = {};
  for (const rows of Object.values(project.clips.tracks))
    for (const clip of rows) {
      if (Object.hasOwn(clips, clip.id))
        throw new Error("Duplicate proxy clip ID");
      clips[clip.id] = {
        track_id: clip.track_id,
        origin_track_id: originTrackId(clip),
        source_id: clip.source_id,
        source_start: clip.source_start,
        source_end: clip.source_end,
        timeline_start: clip.timeline_start,
        timeline_end: clip.timeline_end,
      };
    }
  return {
    history_head_id: project.history.head_id,
    render_hashes: Object.fromEntries(
      Object.entries(project.render_status.tracks ?? {}).flatMap(
        ([id, track]) => (track.render_hash ? [[id, track.render_hash]] : []),
      ),
    ),
    clips,
  };
}

function sortedMap<T>(value: Readonly<Record<string, T>>): [string, T][] {
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
}

export function proxyBasisKey(basis: ProxyProjectBasis): string {
  return JSON.stringify([
    basis.history_head_id,
    sortedMap(basis.render_hashes),
    sortedMap(basis.clips).map(([id, c]) => [
      id,
      c.track_id,
      c.origin_track_id,
      c.source_id,
      c.source_start,
      c.source_end,
      c.timeline_start,
      c.timeline_end,
    ]),
  ]);
}

/** The queue proves only local placements over the same authored audio. */
export function isQueuedMoveOverlay(
  manifest: ProxyManifest,
  displayed: ProxyProjectBasis,
  queue: readonly {
    type: string;
    payload: Record<string, unknown>;
    structural_mode?: string;
  }[],
  trackIds: readonly string[],
): boolean {
  if (
    Object.keys(manifest.artifacts).length !== 0 ||
    Object.keys(manifest.occurrences).length !== 0 ||
    queue.length === 0 ||
    displayed.history_head_id !== manifest.project_basis.history_head_id ||
    JSON.stringify(sortedMap(displayed.render_hashes)) !==
      JSON.stringify(sortedMap(manifest.project_basis.render_hashes))
  )
    return false;
  const clips = { ...manifest.project_basis.clips };
  for (const command of queue) {
    if (
      command.type !== DocumentCommand.MoveClips ||
      command.structural_mode === "propose" ||
      !Array.isArray(command.payload.clips) ||
      command.payload.clips.length === 0 ||
      command.payload.clips.length > 10_000
    )
      return false;
    const seen = new Set<string>();
    for (const item of command.payload.clips) {
      if (!item || typeof item !== "object" || Array.isArray(item))
        return false;
      const move = item as Record<string, unknown>;
      if (
        typeof move.clip_id !== "string" ||
        seen.has(move.clip_id) ||
        typeof move.track_id !== "string" ||
        !trackIds.includes(move.track_id) ||
        typeof move.timeline_start !== "number" ||
        !Number.isFinite(move.timeline_start) ||
        move.timeline_start < 0
      )
        return false;
      const clip = clips[move.clip_id];
      if (!clip) return false;
      seen.add(move.clip_id);
      clips[move.clip_id] = {
        ...clip,
        track_id: move.track_id,
        timeline_start: move.timeline_start,
        timeline_end:
          move.timeline_start + (clip.timeline_end - clip.timeline_start),
      };
    }
  }
  return (
    proxyBasisKey({ ...manifest.project_basis, clips }) ===
    proxyBasisKey(displayed)
  );
}

export function chunkRefKey(ref: ImmutableChunkRef): string {
  return JSON.stringify([ref.kind, ref.artifactId, ref.hash, ref.index]);
}

export function chunkIndexForSource(srcSec: number, chunkSec: number): number {
  return chunkSec <= 0 ? 0 : Math.max(0, Math.floor(srcSec / chunkSec));
}

export function chunkFileStartSec(
  idx: number,
  chunkSec: number,
  overlapMs: number,
): number {
  return Math.max(0, idx * chunkSec - (idx === 0 ? 0 : overlapMs / 1000));
}

export function offsetInChunk(
  srcSec: number,
  idx: number,
  chunkSec: number,
  overlapMs: number,
): number {
  return Math.max(0, srcSec - chunkFileStartSec(idx, chunkSec, overlapMs));
}

export function buildSchedule(
  authoredClips: readonly ClipRow[],
  windowStartSec: number,
  windowEndSec: number,
  manifest: ProxyManifest,
  volumeByTrack: Readonly<Record<string, readonly VolumePoint[]>> = {},
): ScheduledSlice[] {
  const out: ScheduledSlice[] = [];
  const {
    placed: clips,
    overlapIn,
    overlapOut,
    borrowIn,
    borrowOut,
  } = placeLikeRender(authoredClips);
  const beforeCut = clipIdsBeforeCut([...clips]);
  for (const placedClip of clips) {
    // A blending join plays `borrow` seconds of the recording beyond each edge.
    const lead = borrowIn.get(placedClip.id) ?? 0;
    const tail = borrowOut.get(placedClip.id) ?? 0;
    const clip =
      lead > 0 || tail > 0
        ? {
            ...placedClip,
            source_start: placedClip.source_start - lead,
            source_end: placedClip.source_end + tail,
            timeline_start: placedClip.timeline_start - lead,
            timeline_end: placedClip.timeline_end + tail,
          }
        : placedClip;
    const overlapInSec = overlapIn.get(clip.id) ?? 0;
    const overlapAfter = overlapOut.get(clip.id) ?? 0;
    if (
      clip.timeline_end <= windowStartSec ||
      clip.timeline_start >= windowEndSec
    )
      continue;
    const binding = manifest.occurrences[clip.id];
    const artifactId = binding?.artifactId ?? originTrackId(clip);
    const descriptor = binding
      ? manifest.artifacts[artifactId]
      : manifest.tracks[artifactId];
    if (!descriptor) throw new Error("Missing proxy descriptor for occurrence");
    const envelope: ClipEnvelope = {
      // The render applies the envelope of the lane the clip sits on, not the
      // lane its audio came from.
      volume: volumeByTrack[clip.track_id] ?? [],
      timelineStartSec: clip.timeline_start,
      timelineEndSec: clip.timeline_end,
      sourceStartSec: clip.source_start,
      // An occurrence proxy already has its mutes baked in (`source_proxy_audio.py`).
      mute: binding
        ? []
        : muteSpansOf([
            ...(clip.mute_regions ?? []),
            ...(clip.ignored_word_regions ?? []),
          ]),
      automaticMute: binding
        ? []
        : automaticSpansOf(clip.off_speaker_mute_regions),
      // A blending join replaces both edge fades with the overlap's ramps.
      fadeInSec:
        overlapInSec > 0
          ? overlapInSec
          : isCutJoin(clip)
            ? 0
            : Math.max(0, clip.fade_in_ms) / 1000,
      fadeOutSec:
        overlapAfter > 0
          ? overlapAfter
          : beforeCut.has(clip.id)
            ? 0
            : Math.max(0, clip.fade_out_ms) / 1000,
      gainCurve: isCrossfadeJoin(clip) ? "equalPower" : "linear",
    };
    const first = chunkIndexForSource(clip.source_start, descriptor.chunk_sec);
    const last = chunkIndexForSource(
      Math.max(clip.source_start, clip.source_end - 1e-9),
      descriptor.chunk_sec,
    );
    for (let index = first; index <= last; index++) {
      const start = Math.max(clip.source_start, index * descriptor.chunk_sec);
      const end = Math.min(clip.source_end, (index + 1) * descriptor.chunk_sec);
      const whenTimelineSec = clip.timeline_start + start - clip.source_start;
      if (
        end <= start ||
        whenTimelineSec + end - start <= windowStartSec ||
        whenTimelineSec >= windowEndSec
      )
        continue;
      const url = descriptor.urls[index];
      if (index >= descriptor.chunk_count || !url)
        throw new Error("Missing proxy chunk for occurrence");
      out.push({
        chunk: {
          kind: binding ? "artifact" : "track",
          artifactId,
          hash: descriptor.hash,
          index,
          url,
        },
        // The render stages, mutes and faders the lane the clip sits on.
        outputTrackId: clip.track_id,
        bufferOffsetSec: offsetInChunk(
          start,
          index,
          descriptor.chunk_sec,
          descriptor.overlap_ms,
        ),
        durationSec: end - start,
        whenTimelineSec,
        envelope,
      });
    }
  }
  return out;
}
