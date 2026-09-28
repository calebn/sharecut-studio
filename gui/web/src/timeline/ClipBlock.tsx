import {
  memo,
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from "react";
import { rollClipJoin, setClipFade, trimClipEdge } from "../api";
import {
  clampRollDelta,
  clampTrimSourceSec,
  type RollPreview,
  sourceSecFromTimelineDelta,
  type TrimEdge,
} from "../edit/clipEdgePreview";
import {
  type ClipMovePointerInfo,
  type ClipSelectMods,
  waveformTicksToTimeline,
} from "../edit/clipMove";
import {
  isHandleDrag,
  MOVE_THRESHOLD_PX,
  ROLL_COMMIT_MIN_PX,
} from "../edit/dragThreshold";
import { clampFadeMs, edgeFadeMaxMs } from "../edit/fadeLimits";
import { useSnapTicks } from "../hooks/useSnapTicks";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { ClipRow } from "../types/project";
import { EMPTY_ARR } from "../utils/empty";
import { clipMediaStartSec } from "../waveform/mediaRef";
import { type MediaRef, refKind } from "../waveform/types";
import {
  ClipBlockView,
  type ClipHandle,
  type ClipHitHandlers,
} from "./ClipBlockView";
import {
  type ClipFadePreview,
  type ClipTrimPreview,
  clipBlockGeometry,
  type FadeEdge,
} from "./clipBlockGeometry";
import { magnetSec } from "./snapOverlay";
import { useHoldTimelineMetrics } from "./timelineMetrics";
import { WaveformLayer } from "./WaveformLayer";

export interface ClipBlockProps {
  clip: ClipRow;
  trackId: string;
  role: string;
  /** Track name; shown on the clip label only where the header rail is too
   *  narrow to name the lane (phone). */
  trackLabel?: string;
  zoomPxPerSec: number;
  /** The server's edge-fade cap for this track (TrackView.fade_max_ms). */
  fadeMaxMs?: number | null;
  color: string;
  selected: boolean;
  /** Media the clip draws (`waveform/mediaRef.clipMediaRef`). */
  mediaRef: MediaRef;
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
  /**
   * Lane-owned roll preview so both abutting clips stay flush while dragging.
   * Only the two clips of the join get it; the rest get null.
   */
  rollPreview: RollPreview | null;
  onRollPreview: (preview: RollPreview | null) => void;
  /** Select-only (e.g. fade drag start). Callbacks take the clip id first,
   *  so a lane passes one stable function to every clip. */
  onSelect: (clipId: string) => void;
  /** Primary clip-hit click; receives clientX for blade seek. */
  onHit: (clipId: string, clientX: number) => void;
  /** Select-tool body click with Shift/Mod modifiers. */
  onSelectClip?: (clipId: string, mods: ClipSelectMods) => void;
  /** Host or share `edit` — not the host-only handle check. */
  canMove?: boolean;
  bladeMode?: boolean;
  /** Track output gain (dB), for post-fader waveforms. */
  gainDb?: number;
  /** Live body-drag timeline_start; null uses the committed clip. */
  previewTimelineStart?: number | null;
  previewHidden?: boolean;
  moving?: boolean;
  /** Ghost on a dest lane — paint only, no hit/handles. */
  interactive?: boolean;
  onMovePreview?: (clipId: string, info: ClipMovePointerInfo) => void;
  onMoveCommit?: (clipId: string, info: ClipMovePointerInfo) => void;
  onMoveCancel?: () => void;
}

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

export function ClipBlockLive({
  clip,
  trackId,
  role,
  trackLabel,
  zoomPxPerSec,
  fadeMaxMs = null,
  color,
  selected,
  mediaRef,
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
  gainDb = 0,
  previewTimelineStart = null,
  previewHidden = false,
  moving = false,
  interactive = true,
  onMovePreview,
  onMoveCommit,
  onMoveCancel,
}: ClipBlockProps) {
  // Commit handlers read the project path at call time (getState()).
  const editable = useDawStore((s) => !isShareProjectKey(s.projectPath));
  const dragRef = useRef<FadeDrag | TrimDrag | RollDrag | null>(null);
  const bodyRef = useRef<BodyDrag | null>(null);
  const bodyMovedRef = useRef(false);
  const pointerHandledRef = useRef(false);
  const [fadePreview, setFadePreview] = useState<ClipFadePreview | null>(null);
  const [trimPreview, setTrimPreview] = useState<ClipTrimPreview | null>(null);

  const geometry = clipBlockGeometry({
    clip,
    zoomPxPerSec,
    rollPreview,
    trimPreview,
    fadePreview,
    previewTimelineStart,
  });
  const { sourceStart, sourceEnd, rollActive } = geometry;

  // Keep lanes still under a trim, fade or roll drag.
  useHoldTimelineMetrics(
    fadePreview != null || trimPreview != null || rollActive,
  );

  const ticks = useSnapTicks({
    clip,
    trackId,
    sourceStart,
    sourceEnd,
    trimFocusSourceSec:
      trimPreview == null
        ? null
        : trimPreview.edge === "in"
          ? trimPreview.sourceStart
          : trimPreview.sourceEnd,
    enabled: interactive,
  });
  const waveKind = refKind(mediaRef);

  /** Fade lengths for a drag of `d` to `clientX`: the dragged edge moves,
   *  clamped to the track cap and to what the other edge leaves. */
  const fadeAt = (d: FadeDrag, clientX: number) => {
    const dxMs = ((clientX - d.originX) / zoomPxPerSec) * 1000;
    const clipSec = clip.source_end - clip.source_start;
    return d.edge === "in"
      ? {
          inMs: clampFadeMs(
            d.baseIn + dxMs,
            edgeFadeMaxMs(clipSec, fadeMaxMs, d.baseOut),
          ),
          outMs: d.baseOut,
        }
      : {
          inMs: d.baseIn,
          outMs: clampFadeMs(
            d.baseOut - dxMs,
            edgeFadeMaxMs(clipSec, fadeMaxMs, d.baseIn),
          ),
        };
  };

  const commitFade = async (state: FadeDrag, clientX: number) => {
    const next = fadeAt(state, clientX);
    try {
      // A click (under the drag threshold) only selects, and a drag that
      // leaves both lengths unchanged (e.g. already at the cap) writes nothing.
      if (
        isHandleDrag(state.originX, clientX) &&
        (next.inMs !== state.baseIn || next.outMs !== state.baseOut)
      ) {
        await setClipFade(
          useDawStore.getState().projectPath,
          clip.id,
          next.inMs,
          next.outMs,
        );
      }
    } finally {
      dragRef.current = null;
      setFadePreview(null);
    }
  };

  const commitTrim = async (state: TrimDrag, clientX: number) => {
    try {
      // A click (under the drag threshold) only selects: no snap, no ripple,
      // no undo entry.
      if (!isHandleDrag(state.originX, clientX)) {
        return;
      }
      const dxSec = (clientX - state.originX) / zoomPxPerSec;
      const proposed = magnetSec(
        sourceSecFromTimelineDelta(state.baseSourceSec, dxSec),
        ticks,
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
      // A drag the snap or clamp puts back on the committed edge is a no-op.
      if (Math.abs(sourceSec - state.baseSourceSec) < 1e-9) {
        return;
      }
      await trimClipEdge(
        useDawStore.getState().projectPath,
        clip.id,
        state.edge,
        sourceSec,
      );
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
      // A click (under the drag threshold) only selects; a roll the clamp
      // shrinks under ROLL_COMMIT_MIN_PX is a no-op.
      if (
        isHandleDrag(state.originX, clientX) &&
        Math.abs(delta) * zoomPxPerSec >= ROLL_COMMIT_MIN_PX
      ) {
        await rollClipJoin(
          useDawStore.getState().projectPath,
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
    setFadePreview({
      edge,
      inMs: clip.fade_in_ms,
      outMs: clip.fade_out_ms,
    });
    onSelect(clip.id);
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
    onSelect(clip.id);
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
    onSelect(clip.id);
  };

  const onDragMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) {
      return;
    }
    if (d.kind === "fade") {
      setFadePreview({ edge: d.edge, ...fadeAt(d, e.clientX) });
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
      sourceSecFromTimelineDelta(d.baseSourceSec, dxSec),
      ticks,
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

  const extraTicks = () => waveformTicksToTimeline(clip, ticks);

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
      onSelect(clip.id);
    } else {
      onSelectClip?.(clip.id, mods);
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
    onMovePreview?.(clip.id, {
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
        onSelectClip?.(clip.id, d.mods);
      }
      return;
    }
    onMoveCommit?.(clip.id, {
      deltaSec: (e.clientX - d.originX) / zoomPxPerSec,
      clientX: e.clientX,
      clientY: e.clientY,
      extraTicks: extraTicks(),
    });
  };

  const onHandlePointerDown = (
    handle: ClipHandle,
    e: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    switch (handle) {
      case "roll":
        return startRollDrag(e);
      case "fade-in":
        return startFadeDrag("in", e);
      case "fade-out":
        return startFadeDrag("out", e);
      case "trim-in":
        return startTrimDrag("in", e);
      case "trim-out":
        return startTrimDrag("out", e);
    }
  };

  const hitHandlers: ClipHitHandlers = {
    onPointerDown: onBodyDown,
    onPointerMove: onBodyMove,
    onPointerUp: (e) => endBodyDrag(e, false),
    onPointerCancel: (e) => endBodyDrag(e, true),
    onLostPointerCapture: (e) => endBodyDrag(e, true),
    onClick: (e) => {
      e.stopPropagation();
      if (bodyMovedRef.current) {
        bodyMovedRef.current = false;
        pointerHandledRef.current = false;
        return;
      }
      if (bladeMode) {
        onHit(clip.id, e.clientX);
        pointerHandledRef.current = false;
        return;
      }
      if (!pointerHandledRef.current) {
        onSelectClip?.(clip.id, {
          shift: e.shiftKey,
          mod: e.metaKey || e.ctrlKey,
        });
      }
      pointerHandledRef.current = false;
    },
  };

  const showSnapPoints = useDawStore((s) => s.layers.showSnapPoints);
  // Ticks still load for the paused playhead (a body move magnets to them),
  // but draw only where they explain an edit: trimming or in blade mode.
  const drawTicks = showSnapPoints && (trimPreview != null || bladeMode);

  return (
    <ClipBlockView
      clip={clip}
      role={role}
      trackLabel={trackLabel}
      zoomPxPerSec={zoomPxPerSec}
      color={color}
      selected={selected}
      geometry={geometry}
      prevClip={prevClip}
      nextClip={nextClip}
      showHandles={editable && interactive}
      canMove={canMove}
      bladeMode={bladeMode}
      moving={moving}
      previewHidden={previewHidden}
      interactive={interactive}
      snapTicks={drawTicks ? ticks : EMPTY_ARR}
      waveform={
        <WaveformLayer
          mediaRef={mediaRef}
          kind={waveKind}
          mediaStartSec={clipMediaStartSec(clip, sourceStart, mediaRef)}
          clipLeftCss={geometry.left}
          clipWidthCss={geometry.width}
          zoom={zoomPxPerSec}
          colorVar={color}
          role={role}
          gainDb={gainDb}
        />
      }
      ghostWaveform={
        geometry.ghostExtraPx > 0 ? (
          <WaveformLayer
            mediaRef={mediaRef}
            kind={waveKind}
            mediaStartSec={clipMediaStartSec(
              clip,
              geometry.ghostSourceStart,
              mediaRef,
            )}
            clipLeftCss={geometry.left + geometry.committedWidth}
            clipWidthCss={geometry.ghostExtraPx}
            zoom={zoomPxPerSec}
            colorVar={color}
            role={role}
            gainDb={gainDb}
          />
        ) : null
      }
      hitHandlers={interactive ? hitHandlers : undefined}
      onHandlePointerDown={onHandlePointerDown}
      onHandlePointerMove={onDragMove}
      onHandlePointerUp={onDragUp}
    />
  );
}

/** Re-renders only when its own props change (see `TrackLane`). */
export const ClipBlock = memo(ClipBlockLive);
