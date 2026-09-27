import type { DragEvent, MouseEvent } from "react";
import { useLongPress } from "../hooks/useLongPress";
import { useStaleRenderBreakdown } from "../hooks/useStaleRenderBreakdown";
import { canIngestMedia } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type { TrackView } from "../types/project";
import { trackHasSourceAudio } from "../utils/projectMedia";
import { wholeTrackReasonsForTrack } from "../utils/staleRender";
import { TrackHeaderView } from "./TrackHeaderView";
import { TrackMuteSoloButtons } from "./TrackMuteSoloButtons";
import { setTrackReorderData } from "./trackReorder";

interface TrackHeaderProps {
  track: TrackView;
  trackIndex: number;
  selected: boolean;
  onSelect: (additive: boolean) => void;
  reorderEnabled?: boolean;
  /** True while any track-header reorder drag is active (drop allowlist). */
  isReorderDragActive?: () => boolean;
  dragging?: boolean;
  dropEdge?: "before" | "after" | null;
  onReorderDragStart?: (trackId: string, trackIndex: number) => void;
  onReorderDragEnd?: () => void;
  onReorderDragOver?: (
    trackId: string,
    trackIndex: number,
    placeAfter: boolean,
  ) => void;
  onReorderDrop?: (
    trackId: string,
    trackIndex: number,
    placeAfter: boolean,
  ) => void;
}

export function TrackHeader({
  track,
  trackIndex,
  selected,
  onSelect,
  reorderEnabled = false,
  isReorderDragActive,
  dragging = false,
  dropEdge = null,
  onReorderDragStart,
  onReorderDragEnd,
  onReorderDragOver,
  onReorderDrop,
}: TrackHeaderProps) {
  const {
    viewerMute,
    project,
    highlightStaleRender,
    ingestDropTrackId,
    projectPath,
    guestMode,
    shareCapabilities,
  } = useDaw((s) => ({
    viewerMute: s.viewerMute,
    project: s.project,
    highlightStaleRender: s.highlightStaleRender,
    ingestDropTrackId: s.ingestDropTrackId,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
  }));
  const mayReorder =
    reorderEnabled && canIngestMedia(projectPath, guestMode, shareCapabilities);
  const muted = Boolean(viewerMute[track.id]) || track.muted;
  const breakdown = useStaleRenderBreakdown(project);
  // Same source as the status bar and transport: a track with no audio has
  // nothing to render (no dot), and "stale" means the breakdown says so.
  const stemClass = !trackHasSourceAudio(track)
    ? ""
    : breakdown.staleTrackIds.includes(track.id)
      ? "stale"
      : track.stem_is_fresh === true
        ? "fresh"
        : "";
  const wholeReasons = highlightStaleRender
    ? wholeTrackReasonsForTrack(breakdown, track.id)
    : [];
  const hasRegional =
    highlightStaleRender &&
    breakdown.invalidations.some(
      (inv) =>
        inv.track_ids.includes(track.id) &&
        inv.timeline_start != null &&
        inv.timeline_end != null,
    );
  const headerHighlight =
    highlightStaleRender &&
    (wholeReasons.length > 0 ||
      hasRegional ||
      breakdown.staleTrackIds.includes(track.id));
  const dropHighlight = ingestDropTrackId === track.id;
  const longPress = useLongPress(() => onSelect(false));

  const select = (e: MouseEvent) => {
    onSelect(e.metaKey || e.ctrlKey || e.shiftKey);
  };

  const onHandleDragStart = (e: DragEvent) => {
    e.stopPropagation();
    setTrackReorderData(e.dataTransfer, track.id);
    onReorderDragStart?.(track.id, trackIndex);
  };

  const allowReorderDrop = (e: DragEvent) => {
    if (!mayReorder || !isReorderDragActive?.()) {
      return false;
    }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const placeAfter = e.clientY > rect.top + rect.height / 2;
    onReorderDragOver?.(track.id, trackIndex, placeAfter);
    return true;
  };

  const onDrop = (e: DragEvent) => {
    if (!mayReorder || !isReorderDragActive?.()) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const placeAfter = e.clientY > rect.top + rect.height / 2;
    onReorderDrop?.(track.id, trackIndex, placeAfter);
  };

  return (
    <TrackHeaderView
      track={track}
      trackIndex={trackIndex}
      selected={selected}
      muted={muted}
      stemClass={stemClass}
      wholeReasons={wholeReasons}
      hasRegional={hasRegional}
      headerHighlight={headerHighlight}
      dropHighlight={dropHighlight}
      dragging={dragging}
      dropEdge={dropEdge}
      mayReorder={mayReorder}
      mixer={<TrackMuteSoloButtons trackId={track.id} />}
      longPress={longPress}
      onSelect={select}
      onHandleDragStart={onHandleDragStart}
      onReorderDragEnd={onReorderDragEnd}
      onDragOver={allowReorderDrop}
      onDrop={onDrop}
    />
  );
}
