import type {
  CSSProperties,
  DragEventHandler,
  MouseEventHandler,
  ReactNode,
} from "react";
import type { LongPressHandlers } from "../hooks/useLongPress";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { initials } from "../presence/colors";
import { laneColor } from "../timeline/laneColors";
import type { TrackView } from "../types/project";
import { Icon } from "../ui";
import { formatGainDb, trackFaderDb, trackOutputGainDb } from "../utils/audio";
import { REGIONAL_CHIP_LABEL, reasonChipLabel } from "../utils/staleRender";
import {
  outputGainTitle,
  reorderHandleTitle,
  STEM_STATUS_LABEL,
  trackSubtitle,
} from "./trackHeaderCopy";
import { keepActivationKeys } from "./trackHeaderKeys";

export interface TrackHeaderViewProps {
  track: TrackView;
  trackIndex: number;
  selected: boolean;
  muted: boolean;
  stemClass: "" | "fresh" | "stale";
  wholeReasons: string[];
  hasRegional: boolean;
  headerHighlight: boolean;
  dropHighlight: boolean;
  dragging: boolean;
  dropEdge: "before" | "after" | null;
  mayReorder: boolean;
  mixer: ReactNode;
  longPress?: LongPressHandlers;
  onSelect: MouseEventHandler<HTMLButtonElement>;
  onHandleSelect?: () => void;
  onHandleDragStart?: DragEventHandler<HTMLButtonElement>;
  onReorderDragEnd?: () => void;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
}

/** Props-only track gutter rendering for live state and static catalog cases. */
export function TrackHeaderView({
  track,
  trackIndex,
  selected,
  muted,
  stemClass,
  wholeReasons,
  hasRegional,
  headerHighlight,
  dropHighlight,
  dragging,
  dropEdge,
  mayReorder,
  mixer,
  longPress,
  onSelect,
  onHandleSelect,
  onHandleDragStart,
  onReorderDragEnd,
  onDragOver,
  onDrop,
}: TrackHeaderViewProps) {
  const label = track.label || track.id;
  const outputDb = trackOutputGainDb(track);
  const stagingDb = track.gain_db;
  const volumeDb = trackFaderDb(track);
  const identityStyle = {
    "--track-identity-color": laneColor(track.role, trackIndex),
  } as CSSProperties;
  const edgeClass =
    dropEdge === "before"
      ? " drop-before"
      : dropEdge === "after"
        ? " drop-after"
        : "";
  return (
    <div
      className={`track-header-row${muted ? " muted" : ""}${selected ? " selected" : ""}${headerHighlight ? " stale-highlight" : ""}${wholeReasons.length ? " stale-whole-track" : ""}${dropHighlight ? " lane-drop-target" : ""}${dragging ? " dragging" : ""}${edgeClass}${mayReorder ? " reorderable" : ""}`}
      style={identityStyle}
      {...presenceAnchorProps(presenceAnchor("track", track.id))}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <button
        type="button"
        className="track-header-open"
        aria-label={`Open track details, ${label}`}
        aria-expanded={selected}
        {...longPress}
        onClick={onSelect}
        onKeyDown={keepActivationKeys}
      />
      {mayReorder ? (
        <button
          type="button"
          className="track-reorder-handle"
          draggable
          aria-roledescription="drag handle"
          aria-label={`Reorder track ${label}`}
          title={reorderHandleTitle()}
          onDragStart={onHandleDragStart}
          onDragEnd={() => onReorderDragEnd?.()}
          onClick={(e) => {
            e.stopPropagation();
            onHandleSelect?.();
          }}
          onKeyDown={keepActivationKeys}
        />
      ) : null}
      <span className="track-title">
        {/* Phone rail identity: initials in the lane color (the full name is
            on the lane's clip labels and in the open button's name). */}
        <span className="track-chip" aria-hidden="true">
          {initials(label)}
        </span>
        <span className="track-title-text">{label}</span>
        {stemClass && (
          <Icon
            name={stemClass === "stale" ? "refresh" : "check"}
            className={`stem-status ${stemClass}`}
            title={STEM_STATUS_LABEL[stemClass]}
            size={12}
          />
        )}
        {wholeReasons.map((r) => (
          <span
            key={r}
            className="stale-reason-chip"
            title={`${STEM_STATUS_LABEL.stale}: ${reasonChipLabel(r)}`}
          >
            {reasonChipLabel(r)}
          </span>
        ))}
        {hasRegional && !wholeReasons.length ? (
          <span
            className="stale-reason-chip"
            title="Parts of this track are out of date"
          >
            {REGIONAL_CHIP_LABEL}
          </span>
        ) : null}
        <span className="track-header-disclose" aria-hidden="true">
          ›
        </span>
      </span>
      <div className="track-meta">
        <span className="track-role">{trackSubtitle(track)}</span>
        <div className="track-transport-btns">
          {mixer}
          {track.fx_count > 0 && (
            <span className="badge fx" title={`${track.fx_count} effects`}>
              FX {track.fx_count}
            </span>
          )}
        </div>
      </div>
      <span
        className="track-out-gain"
        title={outputGainTitle(outputDb, stagingDb, volumeDb)}
      >
        Out {formatGainDb(outputDb)}
      </span>
    </div>
  );
}
