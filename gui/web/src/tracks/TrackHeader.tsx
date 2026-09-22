import type { DragEvent, MouseEvent } from "react";
import { useLongPress } from "../hooks/useLongPress";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { canIngestMedia } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type { TrackView } from "../types/project";
import {
  reasonChipLabel,
  staleRenderBreakdown,
  wholeTrackReasonsForTrack,
} from "../utils/staleRender";
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

function gainFillPercent(gainDb: number): number {
  const min = -24;
  const max = 12;
  const clamped = Math.max(min, Math.min(max, gainDb));
  return ((clamped - min) / (max - min)) * 100;
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
  } = useDaw();
  const mayReorder =
    reorderEnabled && canIngestMedia(projectPath, guestMode, shareCapabilities);
  const stemClass =
    track.stem_is_fresh === true
      ? "fresh"
      : track.stem_is_fresh === false
        ? "stale"
        : "";
  const muted = Boolean(viewerMute[track.id]) || track.muted;
  const breakdown = staleRenderBreakdown(project);
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
  const label = track.label || track.id;
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

  const edgeClass =
    dropEdge === "before"
      ? " drop-before"
      : dropEdge === "after"
        ? " drop-after"
        : "";

  return (
    <div
      className={`track-header-row${muted ? " muted" : ""}${selected ? " selected" : ""}${headerHighlight ? " stale-highlight" : ""}${wholeReasons.length ? " stale-whole-track" : ""}${dropHighlight ? " lane-drop-target" : ""}${dragging ? " dragging" : ""}${edgeClass}${mayReorder ? " reorderable" : ""}`}
      {...presenceAnchorProps(presenceAnchor("track", track.id))}
      onDragOver={allowReorderDrop}
      onDrop={onDrop}
    >
      <button
        type="button"
        className="track-header-open"
        aria-label={`Open track details, ${label}`}
        aria-expanded={selected}
        onPointerDown={longPress.onPointerDown}
        onClickCapture={longPress.onClickCapture}
        onPointerMove={longPress.onPointerMove}
        onPointerUp={longPress.onPointerUp}
        onPointerCancel={longPress.onPointerCancel}
        onClick={select}
      />
      {mayReorder ? (
        <button
          type="button"
          className="track-reorder-handle"
          draggable
          tabIndex={-1}
          aria-roledescription="drag handle"
          aria-label={`Reorder track ${label}`}
          title="Drag to reorder"
          onDragStart={onHandleDragStart}
          onDragEnd={() => onReorderDragEnd?.()}
          onClick={(e) => e.stopPropagation()}
        />
      ) : null}
      <span className="track-title">
        {stemClass && <span className={`stem-dot ${stemClass}`} />}
        <span className="track-title-text">{label}</span>
        {wholeReasons.map((r) => (
          <span key={r} className="stale-reason-chip" title={`Stale: ${r}`}>
            {reasonChipLabel(r)}
          </span>
        ))}
        {hasRegional && !wholeReasons.length ? (
          <span className="stale-reason-chip" title="Stale regions on lane">
            Regions
          </span>
        ) : null}
        <span className="track-header-disclose" aria-hidden="true">
          ›
        </span>
      </span>
      <div className="track-meta">
        <span className="track-role">
          {track.role}
          {track.speaker ? ` · ${track.speaker}` : ""}
        </span>
        <div className="track-transport-btns">
          <TrackMuteSoloButtons trackId={track.id} />
          {track.fx_count > 0 && (
            <span className="badge fx" title={`${track.fx_count} effects`}>
              FX {track.fx_count}
            </span>
          )}
        </div>
      </div>
      <div className="gain-strip" title={`Gain ${track.gain_db.toFixed(1)} dB`}>
        <div
          className="gain-fill"
          style={{ width: `${gainFillPercent(track.gain_db)}%` }}
        />
        <span className="gain-label">{track.gain_db.toFixed(1)} dB</span>
      </div>
    </div>
  );
}
