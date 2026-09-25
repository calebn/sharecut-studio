import { useRef, useState } from "react";
import type {
  ClipMovePointerInfo,
  ClipSelectMods,
  MoveGhost,
} from "../edit/clipMove";
import { usePeaks } from "../hooks/usePeaks";
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
import { trackHasSourceAudio } from "../utils/projectMedia";
import type { RenderInvalidationView } from "../utils/staleRender";
import { originTrackId } from "../utils/timebase";
import { AppliedEditOverlay } from "./AppliedEditOverlay";
import { ClipBlock } from "./ClipBlock";
import { EnvelopeOverlay } from "./EnvelopeOverlay";
import { laneColor } from "./laneColors";
import { PendingEditOverlay } from "./PendingEditOverlay";
import { StaleInvalidationOverlay } from "./StaleInvalidationOverlay";

interface TrackLaneProps {
  track: TrackView;
  trackIndex: number;
  clips: ClipRow[];
  width: number;
  zoomPxPerSec: number;
  projectPath: string;
  hasPeaks: boolean;
  selection: Selection;
  showLevels: boolean;
  showEdits: boolean;
  envelopes: AutomationEnvelope[];
  appliedRecords: AppliedEditRecord[];
  pendingEdits: PendingEditView[];
  onSeek: (clientX: number, target: HTMLElement) => void;
  onSelectClip: (clipId: string, mods?: ClipSelectMods) => void;
  onSelectTrack: () => void;
  onSelectApplied: (id: string) => void;
  onSelectPending: (id: string) => void;
  bladeHighlight?: boolean;
  /** When true, clip hits seek/blade via lane-seek underlay (not select). */
  bladeMode?: boolean;
  canMoveClips?: boolean;
  selectedClipIds?: string[];
  previewStartById?: Record<string, number>;
  hideClipIds?: ReadonlySet<string>;
  moveGhosts?: MoveGhost[];
  onClipMovePreview?: (clipId: string, info: ClipMovePointerInfo) => void;
  onClipMoveCommit?: (clipId: string, info: ClipMovePointerInfo) => void;
  onClipMoveCancel?: () => void;
  /** Pointer-following cut preview (seconds); only shown on target lanes. */
  bladeHoverSec?: number | null;
  /** Whole-track stale cause → light lane edge (not full wash when bands exist). */
  staleWholeTrack?: boolean;
  /** Cause journal entries for this hover session. */
  staleInvalidations?: RenderInvalidationView[];
  /** Show regional invalidation bands. */
  showStaleInvalidations?: boolean;
}

export function TrackLane({
  track,
  trackIndex,
  clips,
  width,
  zoomPxPerSec,
  projectPath,
  hasPeaks,
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
  selectedClipIds = [],
  previewStartById = {},
  hideClipIds,
  moveGhosts = [],
  onClipMovePreview,
  onClipMoveCommit,
  onClipMoveCancel,
  bladeHoverSec = null,
  staleWholeTrack = false,
  staleInvalidations = [],
  showStaleInvalidations = false,
}: TrackLaneProps) {
  const { peaks, status: peaksStatus } = usePeaks(
    projectPath,
    track.id,
    hasPeaks || trackHasSourceAudio(track),
    `${hasPeaks ? 1 : 0}|${track.media_path ?? ""}|${track.duration_sec ?? ""}`,
  );
  const seekRef = useRef<HTMLDivElement>(null);
  const {
    project,
    guestMode,
    shareCapabilities,
    setIngestDropTrackId,
    setPointerTrackId,
  } = useDaw((s) => ({
    project: s.project,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    setIngestDropTrackId: s.setIngestDropTrackId,
    setPointerTrackId: s.setPointerTrackId,
  }));
  const [dropOver, setDropOver] = useState(false);
  const [dragFileCount, setDragFileCount] = useState(1);
  const [rollPreview, setRollPreview] = useState<{
    leftClipId: string;
    rightClipId: string;
    deltaSec: number;
  } | null>(null);
  const canDrop = canIngestMedia(projectPath, guestMode, shareCapabilities);
  const replacing = trackHasMedia({
    mediaPath: track.media_path,
    clipCount: clips.length,
  });

  const originPaint = (clip: ClipRow) => {
    const tid = originTrackId(clip);
    const src = project?.tracks.find((t) => t.id === tid) ?? track;
    return {
      mediaPath: src.media_path,
      mediaVersion: `${src.media_path ?? ""}|${src.stem_is_fresh ?? ""}|${src.duration_sec ?? ""}`,
    };
  };

  const onClipHit = (clipId: string, clientX: number) => {
    if (bladeMode && seekRef.current) {
      onSeek(clientX, seekRef.current);
      return;
    }
    onSelectClip(clipId);
  };

  const showBladeGuide = bladeMode && bladeHighlight && bladeHoverSec != null;

  const clearDrop = () => {
    setDropOver(false);
    setIngestDropTrackId(null);
  };

  return (
    <div
      className={`lane-row${track.muted ? " muted" : ""}${bladeHighlight ? " blade-target" : ""}${staleWholeTrack ? " stale-whole-track" : ""}${dropOver ? " lane-drop-target" : ""}`}
      style={{ width }}
      data-track-id={track.id}
      data-peaks-status={peaksStatus}
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
      {peaksStatus === "generating" || peaksStatus === "unavailable" ? (
        <div className="lane-peaks-status" role="status">
          {peaksStatus === "generating"
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
      {showBladeGuide ? (
        <div
          className="blade-cut-guide blade-cut-guide--lane"
          style={{ left: bladeHoverSec * zoomPxPerSec }}
          aria-hidden
        />
      ) : null}
      <div className="lane-inner" style={{ width }}>
        {clips.map((clip, i) => {
          const prev = clips[i - 1];
          const next = clips[i + 1];
          const grandPrev = clips[i - 2];
          const mediaDur = track.duration_sec ?? Number.POSITIVE_INFINITY;
          const originId = originTrackId(clip);
          const paint = originPaint(clip);
          return (
            <ClipBlock
              key={clip.id}
              clip={clip}
              trackId={originId}
              role={track.role}
              trackLabel={track.label || track.id}
              zoomPxPerSec={zoomPxPerSec}
              color={laneColor(track.role, trackIndex)}
              selected={
                selectedClipIds.includes(clip.id) ||
                (selection?.kind === "clip" && selection.id === clip.id)
              }
              peaks={originId === track.id ? peaks : null}
              mediaPath={paint.mediaPath}
              mediaVersion={paint.mediaVersion}
              bladeHoverSec={bladeHoverSec}
              prevClip={prev ?? null}
              nextClip={next ?? null}
              neighborSourceLo={prev?.source_end ?? 0}
              neighborSourceHi={next?.source_start ?? mediaDur}
              leftNeighborSourceEnd={grandPrev?.source_end ?? 0}
              mediaDurationSec={mediaDur}
              rollPreview={rollPreview}
              onRollPreview={setRollPreview}
              onSelect={() => onSelectClip(clip.id)}
              onHit={(clientX) => onClipHit(clip.id, clientX)}
              onSelectClip={(mods) => onSelectClip(clip.id, mods)}
              canMove={canMoveClips}
              bladeMode={bladeMode}
              previewTimelineStart={previewStartById[clip.id] ?? null}
              previewHidden={hideClipIds?.has(clip.id) ?? false}
              moving={Boolean(
                hideClipIds?.has(clip.id) || previewStartById[clip.id] != null,
              )}
              onMovePreview={
                onClipMovePreview
                  ? (info) => onClipMovePreview(clip.id, info)
                  : undefined
              }
              onMoveCommit={
                onClipMoveCommit
                  ? (info) => onClipMoveCommit(clip.id, info)
                  : undefined
              }
              onMoveCancel={onClipMoveCancel}
            />
          );
        })}
        {moveGhosts.map((ghost) => (
          <ClipBlock
            key={`ghost-${ghost.clip.id}`}
            clip={ghost.clip}
            trackId={ghost.originTrackId}
            role={track.role}
            zoomPxPerSec={zoomPxPerSec}
            color={laneColor(track.role, ghost.trackIndex)}
            selected={selectedClipIds.includes(ghost.clip.id)}
            peaks={null}
            mediaPath={ghost.mediaPath}
            mediaVersion={ghost.mediaVersion}
            prevClip={null}
            nextClip={null}
            neighborSourceLo={0}
            neighborSourceHi={Number.POSITIVE_INFINITY}
            leftNeighborSourceEnd={0}
            mediaDurationSec={Number.POSITIVE_INFINITY}
            rollPreview={null}
            onRollPreview={() => undefined}
            onSelect={() => undefined}
            onHit={() => undefined}
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
            onSelectTrack={onSelectTrack}
          />
        )}
        {showEdits && (
          <>
            <AppliedEditOverlay
              records={appliedRecords}
              trackId={track.id}
              zoomPxPerSec={zoomPxPerSec}
              selectedId={selection?.kind === "applied" ? selection.id : null}
              onSelect={onSelectApplied}
            />
            <PendingEditOverlay
              edits={pendingEdits}
              trackId={track.id}
              zoomPxPerSec={zoomPxPerSec}
              selectedId={selection?.kind === "pending" ? selection.id : null}
              onSelect={onSelectPending}
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
