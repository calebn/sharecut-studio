import type {
  ButtonHTMLAttributes,
  PointerEventHandler,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from "react";
import { capabilityTooltip } from "../capabilities/copy";
import { isCrossfadeJoin, isCutJoin } from "../edit/joinRender";
import type { ClipRow } from "../types/project";
import { formatDurationCompact } from "../utils/time";
import type { ClipBlockGeometry } from "./clipBlockGeometry";
import { FadeCurves } from "./FadeCurves";

/** Clip-local overlay spans for source regions, clamped to the visible window. */
function RegionSpans({
  regions,
  className,
  keyPrefix,
  sourceStart,
  sourceEnd,
  zoomPxPerSec,
}: {
  regions: readonly { start_s: number; end_s: number }[] | undefined;
  className: string;
  keyPrefix: string;
  sourceStart: number;
  sourceEnd: number;
  zoomPxPerSec: number;
}) {
  return (
    <>
      {(regions ?? []).map((region, i) => {
        const start = Math.max(region.start_s, sourceStart);
        const end = Math.min(region.end_s, sourceEnd);
        if (!(end > start + 1e-9)) {
          return null;
        }
        return (
          <span
            key={`${keyPrefix}-${region.start_s}-${region.end_s}-${i}`}
            className={className}
            style={{
              left: (start - sourceStart) * zoomPxPerSec,
              width: Math.max(1, (end - start) * zoomPxPerSec),
            }}
            aria-hidden
          />
        );
      })}
    </>
  );
}

function clipLabel(role: string, durationSec: number, width: number): string {
  if (width < 24) {
    return "";
  }
  const dur = formatDurationCompact(durationSec);
  if (width < 60) {
    return dur;
  }
  return `${role} · ${dur}`;
}

const NO_TICKS: readonly number[] = [];

export type ClipHandle =
  | "roll"
  | "fade-in"
  | "fade-out"
  | "trim-in"
  | "trim-out";
export type ClipHitHandlers = Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  | "onPointerDown"
  | "onPointerMove"
  | "onPointerUp"
  | "onPointerCancel"
  | "onLostPointerCapture"
  | "onClick"
>;

export interface ClipBlockViewProps {
  clip: ClipRow;
  role: string;
  /** Track name on the clip label where the header rail is too narrow (phone). */
  trackLabel?: string;
  zoomPxPerSec: number;
  color: string;
  selected: boolean;
  /** `clipBlockGeometry` for the committed clip or the live preview. */
  geometry: ClipBlockGeometry;
  /** Previous clip on this track: draws the join diamond. */
  prevClip: ClipRow | null;
  /** Next clip on this track: a cut join into it hides this fade-out. */
  nextClip: ClipRow | null;
  /** Editable project and interactive clip: draw trim, fade and roll handles. */
  showHandles: boolean;
  canMove?: boolean;
  bladeMode?: boolean;
  moving?: boolean;
  previewHidden?: boolean;
  /** Ghost on a dest lane: paint only, no hit or handles. */
  interactive?: boolean;
  /** Inaudible-cut snap ticks (source seconds). */
  snapTicks?: readonly number[];
  /** Clip waveform (the live adapter passes WaveformLayer). */
  waveform?: ReactNode;
  /** Trim-ghost waveform, drawn inside the ghost when `geometry.ghostExtraPx > 0`. */
  ghostWaveform?: ReactNode;
  hitHandlers?: ClipHitHandlers;
  onHandlePointerDown?: (
    handle: ClipHandle,
    e: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onHandlePointerMove?: PointerEventHandler<HTMLButtonElement>;
  onHandlePointerUp?: PointerEventHandler<HTMLButtonElement>;
}

export function ClipBlockView({
  clip,
  role,
  trackLabel,
  zoomPxPerSec,
  color,
  selected,
  geometry,
  prevClip,
  nextClip,
  showHandles,
  canMove = false,
  bladeMode = false,
  moving = false,
  previewHidden = false,
  interactive = true,
  snapTicks = NO_TICKS,
  waveform,
  ghostWaveform,
  hitHandlers,
  onHandlePointerDown,
  onHandlePointerMove,
  onHandlePointerUp,
}: ClipBlockViewProps) {
  const {
    sourceStart,
    sourceEnd,
    durationSec,
    left,
    width,
    committedWidth,
    fadeInMs,
    fadeOutMs,
    fadeInPx,
    fadeOutPx,
    ghostExtraPx,
    fadeDragEdge,
    trimDragging,
  } = geometry;

  const label = clipLabel(role, durationSec, width);
  const trimTip = capabilityTooltip("daw.edit.trimClipEdge");
  const rollTip = capabilityTooltip("daw.edit.rollClipJoin");
  const fadeTip = capabilityTooltip("daw.edit.setClipFade");
  const moveTip = capabilityTooltip("daw.edit.moveClips");
  // Render ignores the fades at a cut join: this clip's fade-in when its
  // incoming join is a cut, its fade-out when the next clip's join is.
  const cutIn = isCutJoin(clip);
  const cutOut = nextClip != null && isCutJoin(nextClip);

  return (
    <div
      className={`clip-block${selected ? " selected" : ""}${isCrossfadeJoin(clip) ? " join-crossfade" : ""}${fadeDragEdge ? " fade-dragging" : ""}${trimDragging ? " trim-dragging" : ""}${moving ? " clip-moving" : ""}${previewHidden ? " clip-move-hidden" : ""}${!interactive ? " clip-move-ghost" : ""}`}
      style={{ left, width, background: color }}
      aria-hidden={!interactive}
      title={
        canMove && !bladeMode && interactive
          ? `${clip.id} · ${role} (${clip.timeline_start.toFixed(3)}–${(clip.timeline_start + (clip.source_end - clip.source_start)).toFixed(3)}s) · ${moveTip}`
          : `${clip.id} · ${role} (${clip.timeline_start.toFixed(3)}–${(clip.timeline_start + (clip.source_end - clip.source_start)).toFixed(3)}s)`
      }
    >
      {interactive ? (
        <button
          type="button"
          className={`clip-hit${canMove && !bladeMode ? " clip-hit-moveable" : ""}`}
          aria-label={`Select clip ${clip.id}`}
          aria-pressed={selected}
          {...hitHandlers}
        />
      ) : null}
      {showHandles && prevClip ? (
        <button
          type="button"
          className="join-diamond"
          title={`${rollTip} · join: ${clip.join_in_mode}`}
          aria-label={rollTip}
          onPointerDown={(e) => onHandlePointerDown?.("roll", e)}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
        />
      ) : interactive && prevClip ? (
        <span
          className="join-diamond"
          title={`Join: ${clip.join_in_mode}`}
          aria-hidden="true"
        />
      ) : null}
      {ghostExtraPx > 0 ? (
        // The clip's padding box starts 1px in (its border): -1 puts the
        // ghost's border box, and so its layer (1px outside the ghost's
        // dashed border, like the clip's), at timeline x left + committedWidth.
        <span
          className="clip-trim-ghost"
          style={{ width: ghostExtraPx, left: committedWidth - 1 }}
          aria-hidden
        >
          {ghostWaveform}
        </span>
      ) : null}
      <FadeCurves
        widthPx={width}
        inPx={cutIn ? 0 : fadeInPx}
        outPx={cutOut ? 0 : fadeOutPx}
      />
      {showHandles && !cutIn ? (
        <button
          type="button"
          className={`fade-corner in${clip.fade_in_ms === 0 ? " zero" : ""}`}
          style={{ left: fadeInPx }}
          title={fadeTip}
          aria-label={`${fadeTip} · in ${fadeInMs} ms`}
          onPointerDown={(e) => onHandlePointerDown?.("fade-in", e)}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
        />
      ) : null}
      {showHandles && !cutOut ? (
        <button
          type="button"
          className={`fade-corner out${clip.fade_out_ms === 0 ? " zero" : ""}`}
          style={{ right: fadeOutPx }}
          title={fadeTip}
          aria-label={`${fadeTip} · out ${fadeOutMs} ms`}
          onPointerDown={(e) => onHandlePointerDown?.("fade-out", e)}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
        />
      ) : null}
      {fadeDragEdge ? (
        <span
          className={`fade-readout ${fadeDragEdge}`}
          style={
            fadeDragEdge === "in" ? { left: fadeInPx } : { right: fadeOutPx }
          }
          aria-hidden="true"
        >
          {fadeDragEdge === "in" ? fadeInMs : fadeOutMs} ms
        </span>
      ) : null}
      {showHandles && (
        <>
          <button
            type="button"
            className="trim-handle in"
            title={`${trimTip} · start`}
            aria-label={`${trimTip} · start`}
            onPointerDown={(e) => onHandlePointerDown?.("trim-in", e)}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
          />
          <button
            type="button"
            className="trim-handle out"
            title={`${trimTip} · end`}
            aria-label={`${trimTip} · end`}
            onPointerDown={(e) => onHandlePointerDown?.("trim-out", e)}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
          />
        </>
      )}
      {waveform}
      {snapTicks.length > 0 ? (
        <span className="clip-waveform-overlays" aria-hidden>
          {snapTicks.map((t) => (
            <span
              key={`s-${t}`}
              className="clip-waveform-snap"
              style={{ left: (t - sourceStart) * zoomPxPerSec }}
            />
          ))}
        </span>
      ) : null}
      <RegionSpans
        regions={clip.mute_regions}
        className="clip-mute-region"
        keyPrefix="mute"
        sourceStart={sourceStart}
        sourceEnd={sourceEnd}
        zoomPxPerSec={zoomPxPerSec}
      />
      <RegionSpans
        regions={clip.clipping_regions}
        className="clip-clipping-region"
        keyPrefix="clipping"
        sourceStart={sourceStart}
        sourceEnd={sourceEnd}
        zoomPxPerSec={zoomPxPerSec}
      />
      {label && (
        <span className="clip-label">
          {trackLabel ? (
            <span className="clip-label-track">{trackLabel}</span>
          ) : null}
          {label}
        </span>
      )}
    </div>
  );
}
