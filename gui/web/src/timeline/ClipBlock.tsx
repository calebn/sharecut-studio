import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { rollClipJoin, setClipFade, trimClipEdge } from "../api";
import { capabilityTooltip } from "../capabilities/copy";
import {
  clampRollDelta,
  clampTrimSourceSec,
  clipGeometryDuringRoll,
  sourceSecFromTimelineDelta,
  type TrimEdge,
} from "../edit/clipEdgePreview";
import {
  type ClipMovePointerInfo,
  type ClipSelectMods,
  MOVE_THRESHOLD_PX,
  waveformTicksToTimeline,
} from "../edit/clipMove";
import { useClipWaveform } from "../hooks/useClipWaveform";
import { isShareProjectKey } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type { ClipRow, PeaksData } from "../types/project";
import { formatDurationCompact } from "../utils/time";
import { magnetSec } from "./snapOverlay";
import { useHoldTimelineMetrics, useTimelineMetrics } from "./timelineMetrics";

interface ClipBlockProps {
  clip: ClipRow;
  trackId: string;
  role: string;
  /** Track name; shown on the clip label only where the header rail is too
   *  narrow to name the lane (phone). */
  trackLabel?: string;
  zoomPxPerSec: number;
  color: string;
  selected: boolean;
  peaks: PeaksData | null;
  mediaPath?: string | null;
  mediaVersion?: string;
  bladeHoverSec?: number | null;
  /** Previous clip on this track (for roll join); null if first. */
  prevClip: ClipRow | null;
  /** Next clip on this track (roll clamp); null if last. */
  nextClip: ClipRow | null;
  /** Source clamp: previous clip source_end (or 0). */
  neighborSourceLo: number;
  /** Source clamp: next clip source_start (or media end / Infinity). */
  neighborSourceHi: number;
  /** For roll: source_end of clip before prevClip (or 0). */
  leftNeighborSourceEnd: number;
  /** Media duration for roll clamp (or Infinity). */
  mediaDurationSec: number;
  /** Lane-owned roll preview so both abutting clips stay flush while dragging. */
  rollPreview: {
    leftClipId: string;
    rightClipId: string;
    deltaSec: number;
  } | null;
  onRollPreview: (
    preview: {
      leftClipId: string;
      rightClipId: string;
      deltaSec: number;
    } | null,
  ) => void;
  /** Select-only (e.g. fade drag start). */
  onSelect: () => void;
  /** Primary clip-hit click; receives clientX for blade seek. */
  onHit: (clientX: number) => void;
  /** Select-tool body click with Shift/Mod modifiers. */
  onSelectClip?: (mods: ClipSelectMods) => void;
  /** Host or share `edit` — not the host-only handle check. */
  canMove?: boolean;
  bladeMode?: boolean;
  /** Live body-drag timeline_start; null uses the committed clip. */
  previewTimelineStart?: number | null;
  previewHidden?: boolean;
  moving?: boolean;
  /** Ghost on a dest lane — paint only, no hit/handles. */
  interactive?: boolean;
  onMovePreview?: (info: ClipMovePointerInfo) => void;
  onMoveCommit?: (info: ClipMovePointerInfo) => void;
  onMoveCancel?: () => void;
}

type FadeEdge = "in" | "out";

type FadeDrag = {
  kind: "fade";
  edge: FadeEdge;
  originX: number;
  baseIn: number;
  baseOut: number;
};

type TrimDrag = {
  kind: "trim";
  edge: TrimEdge;
  originX: number;
  baseSourceSec: number;
  sourceStart: number;
  sourceEnd: number;
};

type RollDrag = {
  kind: "roll";
  originX: number;
  leftClipId: string;
  rightClipId: string;
  leftSourceStart: number;
  leftSourceEnd: number;
  rightSourceStart: number;
  rightSourceEnd: number;
  prevSourceEnd: number;
  nextSourceStart: number;
  mediaEnd: number;
};

type BodyDrag = {
  pointerId: number;
  originX: number;
  originY: number;
  started: boolean;
  mods: ClipSelectMods;
  wasSelected: boolean;
};

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

function msToPx(ms: number, zoomPxPerSec: number): number {
  return Math.max(4, (ms / 1000) * zoomPxPerSec);
}

export function ClipBlock({
  clip,
  trackId,
  role,
  trackLabel,
  zoomPxPerSec,
  color,
  selected,
  peaks,
  mediaPath = null,
  mediaVersion = "",
  bladeHoverSec = null,
  prevClip,
  nextClip,
  neighborSourceLo,
  neighborSourceHi,
  leftNeighborSourceEnd,
  mediaDurationSec,
  rollPreview,
  onRollPreview,
  onSelect,
  onHit,
  onSelectClip,
  canMove = false,
  bladeMode = false,
  previewTimelineStart = null,
  previewHidden = false,
  moving = false,
  interactive = true,
  onMovePreview,
  onMoveCommit,
  onMoveCancel,
}: ClipBlockProps) {
  const { projectPath } = useDaw();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ghostCanvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<FadeDrag | TrimDrag | RollDrag | null>(null);
  const bodyRef = useRef<BodyDrag | null>(null);
  const bodyMovedRef = useRef(false);
  const pointerHandledRef = useRef(false);
  const [fadePreview, setFadePreview] = useState<{
    inMs: number;
    outMs: number;
  } | null>(null);
  const [trimPreview, setTrimPreview] = useState<{
    edge: TrimEdge;
    sourceStart: number;
    sourceEnd: number;
  } | null>(null);

  const rollGeom = clipGeometryDuringRoll(clip, rollPreview);
  const rollActive =
    rollPreview != null &&
    (rollPreview.leftClipId === clip.id || rollPreview.rightClipId === clip.id);

  const sourceStart = rollActive
    ? rollGeom.sourceStart
    : (trimPreview?.sourceStart ?? clip.source_start);
  const sourceEnd = rollActive
    ? rollGeom.sourceEnd
    : (trimPreview?.sourceEnd ?? clip.source_end);
  const durationSec = sourceEnd - sourceStart;
  const timelineStart =
    previewTimelineStart != null && !rollActive
      ? previewTimelineStart
      : rollGeom.timelineStart;
  const left = timelineStart * zoomPxPerSec;
  const width = Math.max(4, durationSec * zoomPxPerSec);
  const committedWidth = Math.max(
    4,
    (clip.source_end - clip.source_start) * zoomPxPerSec,
  );
  const label = clipLabel(role, durationSec, width);
  const editable = !isShareProjectKey(projectPath);
  const fadeInMs = fadePreview?.inMs ?? clip.fade_in_ms;
  const fadeOutMs = fadePreview?.outMs ?? clip.fade_out_ms;
  const fadeInW = fadeInMs > 0 ? msToPx(fadeInMs, zoomPxPerSec) : 0;
  const fadeOutW = fadeOutMs > 0 ? msToPx(fadeOutMs, zoomPxPerSec) : 0;
  const growingOut =
    trimPreview != null && trimPreview.sourceEnd > clip.source_end + 1e-9;
  const growingIn =
    trimPreview != null && trimPreview.sourceStart < clip.source_start - 1e-9;
  // In-edge expand keeps timeline_start fixed — duration grows to the right.
  const ghostSourceStart =
    trimPreview == null
      ? clip.source_start
      : growingIn
        ? trimPreview.sourceStart
        : clip.source_end;
  const ghostSourceEnd =
    trimPreview == null
      ? clip.source_end
      : growingIn
        ? clip.source_start
        : trimPreview.sourceEnd;
  const ghostExtraPx =
    trimPreview != null && (growingOut || growingIn)
      ? Math.abs(ghostSourceEnd - ghostSourceStart) * zoomPxPerSec
      : 0;

  // The canvas fills the clip, so the lane height is part of the paint key.
  const { laneHeight } = useTimelineMetrics();
  // Keep lanes still under a trim, fade or roll drag.
  useHoldTimelineMetrics(
    fadePreview != null || trimPreview != null || rollActive,
  );

  const wave = useClipWaveform({
    clip,
    trackId,
    mediaPath,
    mediaVersion,
    zoomPxPerSec,
    sourceStart,
    sourceEnd,
    peaks,
    trimActive: trimPreview != null,
    bladeHoverSec,
    selected,
    color,
    laneHeight,
  });

  // Runs every render; the hook skips the paint unless its inputs changed.
  useEffect(() => {
    wave.paint(canvasRef.current);
  });

  useEffect(() => {
    if (ghostExtraPx <= 0 || !trimPreview) {
      return;
    }
    wave.paint(ghostCanvasRef.current, {
      sourceStart: ghostSourceStart,
      sourceEnd: ghostSourceEnd,
      cssWidth: ghostExtraPx,
    });
  });

  const commitFade = async (state: FadeDrag, clientX: number) => {
    const dxMs = ((clientX - state.originX) / zoomPxPerSec) * 1000;
    let nextIn = state.baseIn;
    let nextOut = state.baseOut;
    if (state.edge === "in") {
      nextIn = Math.max(0, Math.round(state.baseIn + dxMs));
    } else {
      nextOut = Math.max(0, Math.round(state.baseOut - dxMs));
    }
    try {
      await setClipFade(projectPath, clip.id, nextIn, nextOut);
    } finally {
      dragRef.current = null;
      setFadePreview(null);
    }
  };

  const commitTrim = async (state: TrimDrag, clientX: number) => {
    const dxSec = (clientX - state.originX) / zoomPxPerSec;
    const proposed = magnetSec(
      sourceSecFromTimelineDelta(state.edge, state.baseSourceSec, dxSec),
      wave.ticks,
      zoomPxPerSec,
    );
    const sourceSec = clampTrimSourceSec(
      state.edge,
      proposed,
      state.sourceStart,
      state.sourceEnd,
      neighborSourceLo,
      neighborSourceHi,
    );
    try {
      await trimClipEdge(projectPath, clip.id, state.edge, sourceSec);
    } finally {
      dragRef.current = null;
      setTrimPreview(null);
    }
  };

  const commitRoll = async (state: RollDrag, clientX: number) => {
    const dxSec = (clientX - state.originX) / zoomPxPerSec;
    const delta = clampRollDelta(dxSec, {
      leftSourceStart: state.leftSourceStart,
      leftSourceEnd: state.leftSourceEnd,
      rightSourceStart: state.rightSourceStart,
      rightSourceEnd: state.rightSourceEnd,
      prevSourceEnd: state.prevSourceEnd,
      nextSourceStart: state.nextSourceStart,
      mediaEnd: state.mediaEnd,
    });
    try {
      if (Math.abs(delta) >= 1e-3) {
        await rollClipJoin(
          projectPath,
          state.leftClipId,
          state.rightClipId,
          delta,
        );
      }
    } finally {
      dragRef.current = null;
      onRollPreview(null);
    }
  };

  const startFadeDrag = (edge: FadeEdge, e: ReactPointerEvent) => {
    if (!editable) {
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // optional — move/up still fire on the handle
    }
    dragRef.current = {
      kind: "fade",
      edge,
      originX: e.clientX,
      baseIn: clip.fade_in_ms,
      baseOut: clip.fade_out_ms,
    };
    setFadePreview({ inMs: clip.fade_in_ms, outMs: clip.fade_out_ms });
    onSelect();
  };

  const startTrimDrag = (edge: TrimEdge, e: ReactPointerEvent) => {
    if (!editable) {
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // optional — move/up still fire on the handle
    }
    const baseSourceSec = edge === "out" ? clip.source_end : clip.source_start;
    dragRef.current = {
      kind: "trim",
      edge,
      originX: e.clientX,
      baseSourceSec,
      sourceStart: clip.source_start,
      sourceEnd: clip.source_end,
    };
    setTrimPreview({
      edge,
      sourceStart: clip.source_start,
      sourceEnd: clip.source_end,
    });
    onSelect();
  };

  const startRollDrag = (e: ReactPointerEvent) => {
    if (!editable || !prevClip) {
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // optional
    }
    dragRef.current = {
      kind: "roll",
      originX: e.clientX,
      leftClipId: prevClip.id,
      rightClipId: clip.id,
      leftSourceStart: prevClip.source_start,
      leftSourceEnd: prevClip.source_end,
      rightSourceStart: clip.source_start,
      rightSourceEnd: clip.source_end,
      prevSourceEnd: leftNeighborSourceEnd,
      nextSourceStart: nextClip?.source_start ?? mediaDurationSec,
      mediaEnd: mediaDurationSec,
    };
    onRollPreview({
      leftClipId: prevClip.id,
      rightClipId: clip.id,
      deltaSec: 0,
    });
    onSelect();
  };

  const onDragMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) {
      return;
    }
    if (d.kind === "fade") {
      const dxMs = ((e.clientX - d.originX) / zoomPxPerSec) * 1000;
      if (d.edge === "in") {
        setFadePreview({
          inMs: Math.max(0, Math.round(d.baseIn + dxMs)),
          outMs: d.baseOut,
        });
      } else {
        setFadePreview({
          inMs: d.baseIn,
          outMs: Math.max(0, Math.round(d.baseOut - dxMs)),
        });
      }
      return;
    }
    if (d.kind === "roll") {
      const dxSec = (e.clientX - d.originX) / zoomPxPerSec;
      onRollPreview({
        leftClipId: d.leftClipId,
        rightClipId: d.rightClipId,
        deltaSec: clampRollDelta(dxSec, {
          leftSourceStart: d.leftSourceStart,
          leftSourceEnd: d.leftSourceEnd,
          rightSourceStart: d.rightSourceStart,
          rightSourceEnd: d.rightSourceEnd,
          prevSourceEnd: d.prevSourceEnd,
          nextSourceStart: d.nextSourceStart,
          mediaEnd: d.mediaEnd,
        }),
      });
      return;
    }
    const dxSec = (e.clientX - d.originX) / zoomPxPerSec;
    const proposed = magnetSec(
      sourceSecFromTimelineDelta(d.edge, d.baseSourceSec, dxSec),
      wave.ticks,
      zoomPxPerSec,
    );
    const sourceSec = clampTrimSourceSec(
      d.edge,
      proposed,
      d.sourceStart,
      d.sourceEnd,
      neighborSourceLo,
      neighborSourceHi,
    );
    if (d.edge === "out") {
      setTrimPreview({
        edge: "out",
        sourceStart: d.sourceStart,
        sourceEnd: sourceSec,
      });
    } else {
      setTrimPreview({
        edge: "in",
        sourceStart: sourceSec,
        sourceEnd: d.sourceEnd,
      });
    }
  };

  const onDragUp = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) {
      return;
    }
    if (d.kind === "fade") {
      void commitFade(d, e.clientX);
      return;
    }
    if (d.kind === "roll") {
      void commitRoll(d, e.clientX);
      return;
    }
    void commitTrim(d, e.clientX);
  };

  const extraTicks = () => waveformTicksToTimeline(clip, wave.ticks);

  const onBodyDown = (e: ReactPointerEvent) => {
    if (bladeMode || !interactive) {
      return;
    }
    e.stopPropagation();
    pointerHandledRef.current = true;
    const mods: ClipSelectMods = {
      shift: e.shiftKey,
      mod: e.metaKey || e.ctrlKey,
    };
    const wasSelected = selected;
    if (wasSelected) {
      onSelect();
    } else {
      onSelectClip?.(mods);
    }
    if (!canMove) {
      return;
    }
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // optional
    }
    bodyMovedRef.current = false;
    bodyRef.current = {
      pointerId: e.pointerId,
      originX: e.clientX,
      originY: e.clientY,
      started: false,
      mods,
      wasSelected,
    };
  };

  const onBodyMove = (e: ReactPointerEvent) => {
    const d = bodyRef.current;
    if (!d || d.pointerId !== e.pointerId) {
      return;
    }
    const dist = Math.hypot(e.clientX - d.originX, e.clientY - d.originY);
    if (!d.started) {
      if (dist < MOVE_THRESHOLD_PX) {
        return;
      }
      d.started = true;
      bodyMovedRef.current = true;
    }
    onMovePreview?.({
      deltaSec: (e.clientX - d.originX) / zoomPxPerSec,
      clientX: e.clientX,
      clientY: e.clientY,
      extraTicks: extraTicks(),
    });
  };

  const endBodyDrag = (e: ReactPointerEvent, cancelled: boolean) => {
    const d = bodyRef.current;
    if (!d || d.pointerId !== e.pointerId) {
      return;
    }
    bodyRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    if (cancelled || !d.started) {
      onMoveCancel?.();
      if (!cancelled && d.wasSelected && (d.mods.shift || d.mods.mod)) {
        onSelectClip?.(d.mods);
      }
      return;
    }
    onMoveCommit?.({
      deltaSec: (e.clientX - d.originX) / zoomPxPerSec,
      clientX: e.clientX,
      clientY: e.clientY,
      extraTicks: extraTicks(),
    });
  };

  const trimTip = capabilityTooltip("daw.edit.trimClipEdge");
  const rollTip = capabilityTooltip("daw.edit.rollClipJoin");
  const fadeTip = capabilityTooltip("daw.edit.setClipFade");
  const moveTip = capabilityTooltip("daw.edit.moveClips");
  const showHandles = editable && interactive;

  return (
    <div
      className={`clip-block${selected ? " selected" : ""}${clip.join_in_mode === "crossfade" ? " join-crossfade" : ""}${fadePreview ? " fade-dragging" : ""}${trimPreview || rollActive ? " trim-dragging" : ""}${moving ? " clip-moving" : ""}${previewHidden ? " clip-move-hidden" : ""}${!interactive ? " clip-move-ghost" : ""}`}
      style={{ left, width, background: color }}
      aria-hidden={!interactive}
      title={
        canMove && !bladeMode && interactive
          ? `${clip.id} · ${role} (${clip.timeline_start.toFixed(2)}–${(clip.timeline_start + (clip.source_end - clip.source_start)).toFixed(2)}s) · ${moveTip}`
          : `${clip.id} · ${role} (${clip.timeline_start.toFixed(2)}–${(clip.timeline_start + (clip.source_end - clip.source_start)).toFixed(2)}s)`
      }
    >
      {interactive ? (
        <button
          type="button"
          className={`clip-hit${canMove && !bladeMode ? " clip-hit-moveable" : ""}`}
          aria-label={`Select clip ${clip.id}`}
          aria-pressed={selected}
          onPointerDown={onBodyDown}
          onPointerMove={onBodyMove}
          onPointerUp={(e) => endBodyDrag(e, false)}
          onPointerCancel={(e) => endBodyDrag(e, true)}
          onLostPointerCapture={(e) => endBodyDrag(e, true)}
          onClick={(e) => {
            e.stopPropagation();
            if (bodyMovedRef.current) {
              bodyMovedRef.current = false;
              pointerHandledRef.current = false;
              return;
            }
            if (bladeMode) {
              onHit(e.clientX);
              pointerHandledRef.current = false;
              return;
            }
            if (!pointerHandledRef.current) {
              onSelectClip?.({
                shift: e.shiftKey,
                mod: e.metaKey || e.ctrlKey,
              });
            }
            pointerHandledRef.current = false;
          }}
        />
      ) : null}
      {showHandles && prevClip ? (
        <button
          type="button"
          className="join-diamond"
          title={`${rollTip} · join: ${clip.join_in_mode}`}
          aria-label={rollTip}
          onPointerDown={startRollDrag}
          onPointerMove={onDragMove}
          onPointerUp={onDragUp}
        />
      ) : interactive && prevClip ? (
        <span
          className="join-diamond"
          title={`Join: ${clip.join_in_mode}`}
          aria-hidden="true"
        />
      ) : null}
      {ghostExtraPx > 0 ? (
        <span
          className="clip-trim-ghost"
          style={{ width: ghostExtraPx, left: committedWidth }}
          aria-hidden
        >
          <canvas ref={ghostCanvasRef} className="clip-trim-ghost-canvas" />
        </span>
      ) : null}
      {fadeInW > 0 && (
        <span className="fade-region fade-in-region" style={{ width: fadeInW }}>
          {showHandles && (
            <button
              type="button"
              className="fade-handle end"
              title={fadeTip}
              aria-label={fadeTip}
              onPointerDown={(e) => startFadeDrag("in", e)}
              onPointerMove={onDragMove}
              onPointerUp={onDragUp}
            />
          )}
        </span>
      )}
      {fadeOutW > 0 && (
        <span
          className="fade-region fade-out-region"
          style={{ width: fadeOutW }}
        >
          {showHandles && (
            <button
              type="button"
              className="fade-handle start"
              title={fadeTip}
              aria-label={fadeTip}
              onPointerDown={(e) => startFadeDrag("out", e)}
              onPointerMove={onDragMove}
              onPointerUp={onDragUp}
            />
          )}
        </span>
      )}
      {showHandles && fadeInMs === 0 && (
        <button
          type="button"
          className="fade-handle end fade-handle-zero in"
          title={fadeTip}
          aria-label={fadeTip}
          onPointerDown={(e) => startFadeDrag("in", e)}
          onPointerMove={onDragMove}
          onPointerUp={onDragUp}
        />
      )}
      {showHandles && fadeOutMs === 0 && (
        <button
          type="button"
          className="fade-handle start fade-handle-zero out"
          title={fadeTip}
          aria-label={fadeTip}
          onPointerDown={(e) => startFadeDrag("out", e)}
          onPointerMove={onDragMove}
          onPointerUp={onDragUp}
        />
      )}
      {showHandles && (
        <>
          <button
            type="button"
            className="trim-handle in"
            title={`${trimTip} · start`}
            aria-label={`${trimTip} · start`}
            onPointerDown={(e) => startTrimDrag("in", e)}
            onPointerMove={onDragMove}
            onPointerUp={onDragUp}
          />
          <button
            type="button"
            className="trim-handle out"
            title={`${trimTip} · end`}
            aria-label={`${trimTip} · end`}
            onPointerDown={(e) => startTrimDrag("out", e)}
            onPointerMove={onDragMove}
            onPointerUp={onDragUp}
          />
        </>
      )}
      {!wave.window.offscreen ? (
        <>
          <canvas
            ref={canvasRef}
            className="clip-waveform"
            aria-hidden
            style={{
              left: wave.window.canvasLeft,
              width: Math.max(1, wave.window.cssWidth),
              height: "100%",
            }}
          />
          <span className="clip-waveform-overlays" aria-hidden>
            {wave.quiet.map((band) => (
              <span
                key={`q-${band.startSec}-${band.endSec}`}
                className="clip-waveform-quiet"
                style={{
                  left: (band.startSec - sourceStart) * zoomPxPerSec,
                  width: Math.max(
                    1,
                    (band.endSec - band.startSec) * zoomPxPerSec,
                  ),
                }}
              />
            ))}
            {wave.ticks.map((t) => (
              <span
                key={`s-${t}`}
                className="clip-waveform-snap"
                style={{ left: (t - sourceStart) * zoomPxPerSec }}
              />
            ))}
          </span>
        </>
      ) : null}
      {(clip.mute_regions ?? []).map((region, i) => {
        const start = Math.max(region.start_s, sourceStart);
        const end = Math.min(region.end_s, sourceEnd);
        if (!(end > start + 1e-9)) {
          return null;
        }
        return (
          <span
            key={`mute-${region.start_s}-${region.end_s}-${i}`}
            className="clip-mute-region"
            style={{
              left: (start - sourceStart) * zoomPxPerSec,
              width: Math.max(1, (end - start) * zoomPxPerSec),
            }}
            aria-hidden
          />
        );
      })}
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
