import type {
  ButtonHTMLAttributes,
  PointerEventHandler,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from "react";
import { capabilityTooltip } from "../capabilities/copy";
import { isCrossfadeJoin, isCutJoin } from "../edit/joinRender";
import type { ClipRow } from "../types/project";
import { clipLabels } from "../utils/clipLabels";
import type { ClipBlockGeometry } from "./clipBlockGeometry";
import { FadeCurves } from "./FadeCurves";
import { HIT_SURFACE_PROPS, hitTargetProps } from "./hitTargets";
import { timelineTestIds } from "./selectors";

/** Clip-local overlay spans for source regions, clamped to the visible window. */
function RegionSpans({
  regions,
  className,
  keyPrefix,
  testId,
  sourceStart,
  sourceEnd,
  zoomPxPerSec,
}: {
  regions: readonly { start_s: number; end_s: number }[] | undefined;
  className: string;
  keyPrefix: string;
  testId?: string;
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
            data-testid={testId}
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

function clipLabel(speaker: string, duration: string, width: number): string {
  if (width < 24) {
    return "";
  }
  if (width < 60) {
    return speaker;
  }
  return `${speaker} · ${duration}`;
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
  | "onBlur"
  | "onClick"
>;

export interface ClipBlockViewProps {
  clip: ClipRow;
  role: string;
  /** Speaker identity from the clip's origin track; falls back to its label. */
  trackSpeaker?: string;
  /** Track name on the clip label where the header rail is too narrow (phone). */
  trackLabel?: string;
  zoomPxPerSec: number;
  color: string;
  selected: boolean;
  /** `clipBlockGeometry` for the committed clip or the live preview. */
  geometry: ClipBlockGeometry;
  /** Previous clip on this track: draws the roll seam. */
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
  onHandlePointerCancel?: PointerEventHandler<HTMLButtonElement>;
  onHandleFocus?: (
    handle: ClipHandle,
    event: ReactFocusEvent<HTMLButtonElement>,
  ) => void;
  onHandleBlur?: (handle: ClipHandle) => void;
  onHandleKeyDown?: (
    handle: ClipHandle,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  onHandleKeyUp?: (
    handle: ClipHandle,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
}

export function ClipBlockView({
  clip,
  role,
  trackSpeaker,
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
  onHandlePointerCancel,
  onHandleFocus,
  onHandleBlur,
  onHandleKeyDown,
  onHandleKeyUp,
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

  const timelineStart = left / zoomPxPerSec;
  const timelineEnd = timelineStart + durationSec;
  const labels = clipLabels({
    clip: {
      source_start: sourceStart,
      source_end: sourceEnd,
      timeline_start: timelineStart,
      timeline_end: timelineStart + durationSec,
    },
    trackSpeaker,
    trackLabel,
    role,
  });
  const label = clipLabel(labels.speaker, labels.duration, width);
  const trimTip = capabilityTooltip("daw.edit.trimClipEdge");
  const rollTip = capabilityTooltip("daw.edit.rollClipJoin");
  const fadeTip = capabilityTooltip("daw.edit.setClipFade");
  const moveTip = capabilityTooltip("daw.edit.moveClips");
  const title =
    canMove && !bladeMode && interactive
      ? `${labels.select} · ${moveTip}`
      : labels.select;
  // Render ignores the fades at a cut join: this clip's fade-in when its
  // incoming join is a cut, its fade-out when the next clip's join is.
  const cutIn = isCutJoin(clip);
  const cutOut = nextClip != null && isCutJoin(nextClip);

  return (
    <div
      data-testid={
        interactive ? timelineTestIds.clip : timelineTestIds.moveGhost
      }
      data-clip-id={clip.id}
      className={`clip-block${selected ? " selected" : ""}${isCrossfadeJoin(clip) ? " join-crossfade" : ""}${fadeDragEdge ? " fade-dragging" : ""}${trimDragging ? " trim-dragging" : ""}${moving ? " clip-moving" : ""}${previewHidden ? " clip-move-hidden" : ""}${!interactive ? " clip-move-ghost" : ""}`}
      style={{ left, width, backgroundColor: color }}
      aria-hidden={!interactive}
      title={title}
    >
      {interactive ? (
        <button
          type="button"
          className={`clip-hit${canMove && !bladeMode ? " clip-hit-moveable" : ""}`}
          title={title}
          aria-label={labels.select}
          aria-pressed={selected}
          {...HIT_SURFACE_PROPS}
          {...hitHandlers}
        />
      ) : null}
      {showHandles && prevClip ? (
        <button
          type="button"
          className="join-seam"
          {...hitTargetProps("roll", clip.id, timelineStart)}
          title={`${rollTip} · join: ${clip.join_in_mode}`}
          aria-label={rollTip}
          onPointerDown={(e) => onHandlePointerDown?.("roll", e)}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
        />
      ) : interactive && prevClip ? (
        <span
          className="join-seam"
          title={`Join: ${clip.join_in_mode}`}
          aria-hidden="true"
        />
      ) : null}
      {ghostExtraPx > 0 ? (
        // The clip's padding box starts 1px in (its border): -1 puts the
        // ghost's border box, and so its layer (1px outside the ghost's
        // dashed border, like the clip's), at timeline x left + committedWidth.
        <span
          data-testid={timelineTestIds.trimGhost}
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
          {...hitTargetProps(
            "fade-in",
            clip.id,
            timelineStart + fadeInMs / 1000,
            {
              selected: fadeDragEdge === "in",
            },
          )}
          style={{ left: fadeInPx }}
          title={fadeTip}
          aria-label={`${fadeTip} · in ${fadeInMs} ms. Arrow keys adjust; Shift takes larger steps; Escape cancels. Inspector also sets the length.`}
          onPointerDown={(e) => onHandlePointerDown?.("fade-in", e)}
          onFocus={(e) => onHandleFocus?.("fade-in", e)}
          onBlur={() => onHandleBlur?.("fade-in")}
          onKeyDown={(e) => onHandleKeyDown?.("fade-in", e)}
          onKeyUp={(e) => onHandleKeyUp?.("fade-in", e)}
          onPointerCancel={onHandlePointerCancel}
          onLostPointerCapture={onHandlePointerCancel}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
        />
      ) : null}
      {showHandles && !cutOut ? (
        <button
          type="button"
          className={`fade-corner out${clip.fade_out_ms === 0 ? " zero" : ""}`}
          {...hitTargetProps(
            "fade-out",
            clip.id,
            timelineEnd - fadeOutMs / 1000,
            {
              selected: fadeDragEdge === "out",
            },
          )}
          style={{ right: fadeOutPx }}
          title={fadeTip}
          aria-label={`${fadeTip} · out ${fadeOutMs} ms. Arrow keys adjust; Shift takes larger steps; Escape cancels. Inspector also sets the length.`}
          onPointerDown={(e) => onHandlePointerDown?.("fade-out", e)}
          onFocus={(e) => onHandleFocus?.("fade-out", e)}
          onBlur={() => onHandleBlur?.("fade-out")}
          onKeyDown={(e) => onHandleKeyDown?.("fade-out", e)}
          onKeyUp={(e) => onHandleKeyUp?.("fade-out", e)}
          onPointerCancel={onHandlePointerCancel}
          onLostPointerCapture={onHandlePointerCancel}
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
            {...hitTargetProps("trim-in", clip.id, timelineStart)}
            title={`${trimTip} · start`}
            aria-label={`${trimTip} · start. Arrow keys adjust; Shift takes larger steps; Escape cancels.`}
            onPointerDown={(e) => onHandlePointerDown?.("trim-in", e)}
            onFocus={(e) => onHandleFocus?.("trim-in", e)}
            onBlur={() => onHandleBlur?.("trim-in")}
            onKeyDown={(e) => onHandleKeyDown?.("trim-in", e)}
            onKeyUp={(e) => onHandleKeyUp?.("trim-in", e)}
            onPointerCancel={onHandlePointerCancel}
            onLostPointerCapture={onHandlePointerCancel}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
          />
          <button
            type="button"
            data-testid={timelineTestIds.trimOut}
            className="trim-handle out"
            {...hitTargetProps("trim-out", clip.id, timelineEnd)}
            title={`${trimTip} · end`}
            aria-label={`${trimTip} · end. Arrow keys adjust; Shift takes larger steps; Escape cancels.`}
            onPointerDown={(e) => onHandlePointerDown?.("trim-out", e)}
            onFocus={(e) => onHandleFocus?.("trim-out", e)}
            onBlur={() => onHandleBlur?.("trim-out")}
            onKeyDown={(e) => onHandleKeyDown?.("trim-out", e)}
            onKeyUp={(e) => onHandleKeyUp?.("trim-out", e)}
            onPointerCancel={onHandlePointerCancel}
            onLostPointerCapture={onHandlePointerCancel}
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
              data-testid={timelineTestIds.snapTick}
              data-source-sec={t}
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
        testId={timelineTestIds.muteRegion}
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
      {label && <span className="clip-label">{label}</span>}
    </div>
  );
}
