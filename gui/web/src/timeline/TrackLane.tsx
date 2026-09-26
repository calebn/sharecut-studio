import { memo, useCallback, useMemo, useRef, useState } from "react";
import type {
  ClipMovePointerInfo,
  ClipSelectMods,
  MoveGhost,
} from "../edit/clipMove";
import {
  audioFilesFromDrop,
  fileCountFromDataTransfer,
  laneDropLabel,
  trackHasMedia,
} from "../ingest/dropLabels";
import { ingestFiles } from "../ingest/ingestFiles";
import { canIngestMedia } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type {
  AppliedEditRecord,
  AutomationEnvelope,
  ClipRow,
  PendingEditView,
  Selection,
  TrackView,
} from "../types/project";
import { EMPTY_ARR, EMPTY_OBJ } from "../utils/empty";
import type { RenderInvalidationView } from "../utils/staleRender";
import { originTrackId } from "../utils/timebase";
import { clipMediaRef } from "../waveform/mediaRef";
import { useLaneWaveformStatus } from "../waveform/statusStore";
import { AppliedEditOverlay } from "./AppliedEditOverlay";
import { ClipBlock } from "./ClipBlock";
import { EnvelopeOverlay } from "./EnvelopeOverlay";
import { laneColor } from "./laneColors";
import { PendingEditOverlay } from "./PendingEditOverlay";
import { StaleInvalidationOverlay } from "./StaleInvalidationOverlay";

type RollPreview = {
  leftClipId: string;
  rightClipId: string;
  deltaSec: number;
};

const NOOP = () => undefined;

interface TrackLaneProps {
  track: TrackView;
  trackIndex: number;
  clips: readonly ClipRow[];
  width: number;
  zoomPxPerSec: number;
  projectPath: string;
  selection: Selection;
  showLevels: boolean;
  showEdits: boolean;
  envelopes: AutomationEnvelope[];
  appliedRecords: AppliedEditRecord[];
  pendingEdits: PendingEditView[];
  onSeek: (clientX: number, target: HTMLElement) => void;
  /** Lane callbacks take the track id first, so the timeline passes one
   *  stable function to every lane. */
  onSelectClip: (
    trackId: string,
    clipId: string,
    mods?: ClipSelectMods,
  ) => void;
  onSelectTrack: (trackId: string) => void;
  onSelectApplied: (trackId: string, id: string) => void;
  onSelectPending: (trackId: string, id: string) => void;
  bladeHighlight?: boolean;
  /** When true, clip hits seek/blade via lane-seek underlay (not select). */
  bladeMode?: boolean;
  canMoveClips?: boolean;
  selectedClipIds?: readonly string[];
  previewStartById?: Readonly<Record<string, number>>;
  hideClipIds?: ReadonlySet<string>;
  moveGhosts?: readonly MoveGhost[];
  onClipMovePreview?: (clipId: string, info: ClipMovePointerInfo) => void;
  onClipMoveCommit?: (clipId: string, info: ClipMovePointerInfo) => void;
  onClipMoveCancel?: () => void;
  /** Whole-track stale cause → light lane edge (not full wash when bands exist). */
  staleWholeTrack?: boolean;
  /** Cause journal entries for this hover session. */
  staleInvalidations?: readonly RenderInvalidationView[];
  /** Show regional invalidation bands. */
  showStaleInvalidations?: boolean;
}

export function TrackLaneView({
  track,
  trackIndex,
  clips,
  width,
  zoomPxPerSec,
  projectPath,
  selection,
  showLevels,
  showEdits,
  envelopes,
  appliedRecords,
  pendingEdits,
  onSeek,
  onSelectClip,
  onSelectTrack,
  onSelectApplied,
  onSelectPending,
  bladeHighlight = false,
  bladeMode = false,
  canMoveClips = false,
  selectedClipIds = EMPTY_ARR,
  previewStartById = EMPTY_OBJ,
  hideClipIds,
  moveGhosts = EMPTY_ARR,
  onClipMovePreview,
  onClipMoveCommit,
  onClipMoveCancel,
  staleWholeTrack = false,
  staleInvalidations = EMPTY_ARR,
  showStaleInvalidations = false,
}: TrackLaneProps) {
  const seekRef = useRef<HTMLDivElement>(null);
  const {
    auditionMode,
    guestMode,
    shareCapabilities,
    setIngestDropTrackId,
    setPointerTrackId,
  } = useDaw((s) => ({
    auditionMode: s.auditionMode,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    setIngestDropTrackId: s.setIngestDropTrackId,
    setPointerTrackId: s.setPointerTrackId,
  }));
  const [dropOver, setDropOver] = useState(false);
  const [dragFileCount, setDragFileCount] = useState(1);
  const [rollPreview, setRollPreview] = useState<RollPreview | null>(null);
  const canDrop = canIngestMedia(projectPath, guestMode, shareCapabilities);
  const replacing = trackHasMedia({
    mediaPath: track.media_path,
    clipCount: clips.length,
  });

  // FX mode draws the lane's fresh stem; otherwise each clip's own media.
  const waveKind = auditionMode === "fx" ? "stem" : "raw";
  const mediaRefs = useMemo(
    () => clips.map((clip) => clipMediaRef(clip, track, waveKind)),
    [clips, track, waveKind],
  );
  const refsKey = useMemo(
    () => [...new Set(mediaRefs)].sort().join("\n"),
    [mediaRefs],
  );
  const waveformStatus = useLaneWaveformStatus(projectPath, refsKey);

  const trackId = track.id;
  const selectClip = useCallback(
    (clipId: string, mods?: ClipSelectMods) =>
      onSelectClip(trackId, clipId, mods),
    [onSelectClip, trackId],
  );
  const selectTrack = useCallback(
    () => onSelectTrack(trackId),
    [onSelectTrack, trackId],
  );
  const selectApplied = useCallback(
    (id: string) => onSelectApplied(trackId, id),
    [onSelectApplied, trackId],
  );
  const selectPending = useCallback(
    (id: string) => onSelectPending(trackId, id),
    [onSelectPending, trackId],
  );
  const onClipHit = useCallback(
    (clipId: string, clientX: number) => {
      if (bladeMode && seekRef.current) {
        onSeek(clientX, seekRef.current);
        return;
      }
      selectClip(clipId);
    },
    [bladeMode, onSeek, selectClip],
  );

  const clearDrop = () => {
    setDropOver(false);
    setIngestDropTrackId(null);
  };

  return (
    <div
      className={`lane-row${track.muted ? " muted" : ""}${bladeHighlight ? " blade-target" : ""}${staleWholeTrack ? " stale-whole-track" : ""}${dropOver ? " lane-drop-target" : ""}`}
      style={{ width }}
      data-track-id={track.id}
      data-waveform-status={waveformStatus}
      onPointerEnter={(e) => {
        if (e.pointerType === "touch") {
          return;
        }
        setPointerTrackId(track.id);
      }}
      onPointerLeave={() => setPointerTrackId(null)}
      onDragOver={
        canDrop
          ? (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              const n = e.dataTransfer.files?.length || dragFileCount;
              const fromItems = fileCountFromDataTransfer(e.dataTransfer);
              setDragFileCount(Math.max(1, fromItems || n));
              setDropOver(true);
              setIngestDropTrackId(track.id);
            }
          : undefined
      }
      onDragLeave={canDrop ? () => clearDrop() : undefined}
      onDrop={
        canDrop
          ? (e) => {
              e.preventDefault();
              clearDrop();
              const files = audioFilesFromDrop(e.dataTransfer.files);
              if (files.length) {
                void ingestFiles(files, { kind: "track", id: track.id });
              }
            }
          : undefined
      }
    >
      {dropOver ? (
        <div className="lane-drop-label" aria-hidden>
          {laneDropLabel({
            trackLabel: track.label || track.id,
            replacing,
            fileCount: dragFileCount,
          })}
        </div>
      ) : null}
      {waveformStatus === "generating" || waveformStatus === "unavailable" ? (
        <div className="lane-waveform-status" role="status">
          {waveformStatus === "generating"
            ? "Generating waveform…"
            : "Waveform unavailable"}
        </div>
      ) : null}
      {/*
        Position-based seek underlay; keyboard scrub uses TimeRuler (role=slider).
        A div (not button) so Lighthouse target-size ignores this full-lane hit area.
      */}
      <div
        ref={seekRef}
        className="lane-seek"
        role="presentation"
        onClick={(e) => onSeek(e.clientX, e.currentTarget)}
      />
      <div className="lane-inner" style={{ width }}>
        {clips.map((clip, i) => {
          const prev = clips[i - 1];
          const next = clips[i + 1];
          const grandPrev = clips[i - 2];
          const mediaDur = track.duration_sec ?? Number.POSITIVE_INFINITY;
          const originId = originTrackId(clip);
          return (
            <ClipBlock
              key={clip.id}
              clip={clip}
              trackId={originId}
              role={track.role}
              trackLabel={track.label || track.id}
              zoomPxPerSec={zoomPxPerSec}
              fadeMaxMs={track.fade_max_ms ?? null}
              color={laneColor(track.role, trackIndex)}
              selected={
                selectedClipIds.includes(clip.id) ||
                (selection?.kind === "clip" && selection.id === clip.id)
              }
              mediaRef={mediaRefs[i]!}
              prevClip={prev ?? null}
              nextClip={next ?? null}
              neighborSourceLo={prev?.source_end ?? 0}
              neighborSourceHi={next?.source_start ?? mediaDur}
              leftNeighborSourceEnd={grandPrev?.source_end ?? 0}
              mediaDurationSec={mediaDur}
              rollPreview={
                rollPreview &&
                (rollPreview.leftClipId === clip.id ||
                  rollPreview.rightClipId === clip.id)
                  ? rollPreview
                  : null
              }
              onRollPreview={setRollPreview}
              onSelect={selectClip}
              onHit={onClipHit}
              onSelectClip={selectClip}
              canMove={canMoveClips}
              bladeMode={bladeMode}
              previewTimelineStart={previewStartById[clip.id] ?? null}
              previewHidden={hideClipIds?.has(clip.id) ?? false}
              moving={Boolean(
                hideClipIds?.has(clip.id) || previewStartById[clip.id] != null,
              )}
              onMovePreview={onClipMovePreview}
              onMoveCommit={onClipMoveCommit}
              onMoveCancel={onClipMoveCancel}
            />
          );
        })}
        {/* Move ghosts draw raw media on purpose. A stem is per lane and on
            the timeline clock, so the destination lane's stem read at the
            ghost's new timeline_start would show unrelated audio. After the
            drop both lanes' stems are stale and clipMediaRef falls back to
            raw, so raw previews the post-drop waveform (docs/waveform.md). */}
        {moveGhosts.map((ghost) => (
          <ClipBlock
            key={`ghost-${ghost.clip.id}`}
            clip={ghost.clip}
            trackId={ghost.originTrackId}
            role={track.role}
            zoomPxPerSec={zoomPxPerSec}
            color={laneColor(track.role, ghost.trackIndex)}
            selected={selectedClipIds.includes(ghost.clip.id)}
            mediaRef={clipMediaRef(ghost.clip, track, "raw")}
            prevClip={null}
            nextClip={null}
            neighborSourceLo={0}
            neighborSourceHi={Number.POSITIVE_INFINITY}
            leftNeighborSourceEnd={0}
            mediaDurationSec={Number.POSITIVE_INFINITY}
            rollPreview={null}
            onRollPreview={NOOP}
            onSelect={NOOP}
            onHit={NOOP}
            interactive={false}
            moving
          />
        ))}
        {showLevels && (
          <EnvelopeOverlay
            envelopes={envelopes}
            trackId={track.id}
            zoomPxPerSec={zoomPxPerSec}
            width={width}
            onSelectTrack={selectTrack}
          />
        )}
        {showEdits && (
          <>
            <AppliedEditOverlay
              records={appliedRecords}
              trackId={track.id}
              zoomPxPerSec={zoomPxPerSec}
              selectedId={selection?.kind === "applied" ? selection.id : null}
              onSelect={selectApplied}
            />
            <PendingEditOverlay
              edits={pendingEdits}
              trackId={track.id}
              zoomPxPerSec={zoomPxPerSec}
              selectedId={selection?.kind === "pending" ? selection.id : null}
              onSelect={selectPending}
            />
          </>
        )}
        {showStaleInvalidations ? (
          <StaleInvalidationOverlay
            invalidations={staleInvalidations}
            trackId={track.id}
            zoomPxPerSec={zoomPxPerSec}
            width={width}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Re-renders only when its own props change: a playhead or scroll tick
 *  never reaches the lanes. */
export const TrackLane = memo(TrackLaneView);
