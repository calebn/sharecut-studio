import {
  memo,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { rollClipJoin } from "../api";
import {
  type BoundaryGeometryClip,
  type BoundaryTarget,
  loadBoundaryContext,
} from "../api/boundary";
import { type RollPreview } from "../edit/clipEdgePreview";
import {
  type ClipMovePointerInfo,
  type ClipSelectMods,
  waveformTicksToTimeline,
} from "../edit/clipMove";
import { isHandleDrag, ROLL_COMMIT_MIN_PX } from "../edit/dragThreshold";
import { rippleTrimOf } from "../edit/ripplePreview";
import {
  clampToRollInterval,
  type RollJoinInterval,
  rollJoinInterval,
} from "../edit/rollLimits";
import { MOVE_THRESHOLD_PX } from "../hooks/gestureConstants";
import { useSnapTicks } from "../hooks/useSnapTicks";
import { hasShareCapability, isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { trackEditSave } from "../state/hostSendOrder";
import type { ClipRow } from "../types/project";
import { EMPTY_ARR } from "../utils/empty";
import { clipMediaStartSec } from "../waveform/mediaRef";
import { type MediaRef, refKind } from "../waveform/types";
import {
  ClipBlockView,
  type ClipHandle,
  type ClipHitHandlers,
} from "./ClipBlockView";
import { clipBlockGeometry } from "./clipBlockGeometry";
import { HIT_KINDS } from "./inputContract";
import { useHoldTimelineMetrics } from "./timelineMetrics";
import { useClipEdgeHandles } from "./useClipEdgeHandles";
import { WaveformLayer } from "./WaveformLayer";

export interface ClipBlockProps {
  onRangeGesture?: import("./useRangeGesture").RangeGesture;
  clip: ClipRow;
  trackId: string;
  role: string;
  /** Track name; shown on the clip label only where the header rail is too
   *  narrow to name the lane (phone). */
  trackLabel?: string;
  /** Speaker identity from the clip's origin track, for labels and names. */
  trackSpeaker?: string;
  zoomPxPerSec: number;
  /** The server's edge-fade cap for this track (TrackView.fade_max_ms). */
  fadeMaxMs?: number | null;
  color: string;
  selected: boolean;
  /** Media the clip draws (`waveform/mediaRef.clipMediaRef`). */
  mediaRef: MediaRef;
  /** Previous clip on this track when it abuts this one (a join, which a roll moves); null if first or past a gap. */
  prevClip: ClipRow | null;
  /** Next clip on this track (roll clamp); null if last. */
  nextClip: ClipRow | null;
  /** Source clamp: previous clip source_end (or 0). */
  neighborSourceLo: number;
  /** Source clamp: next clip source_start (or media end / Infinity). */
  neighborSourceHi: number;
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
  onMoveCancel?: (clipId: string) => void;
  onBodyStart?: (clipId: string) => boolean;
  onBodyEnd?: (clipId: string) => void;
}

type RollDrag = {
  originX: number;
  interval: RollJoinInterval;
  expectedGeometry: BoundaryGeometryClip[];
  projectPath: string;
  projectEpoch: number;
};

type BodyDrag = {
  clip: ClipRow;
  projectPath: string;
  projectEpoch: number;
  target: HTMLElement;
  stopListening: () => void;
  rangeCandidate: boolean;
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
  trackSpeaker,
  zoomPxPerSec,
  fadeMaxMs = null,
  color,
  selected,
  mediaRef,
  prevClip,
  nextClip,
  neighborSourceLo,
  neighborSourceHi,
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
  onBodyStart,
  onBodyEnd,
  onRangeGesture,
}: ClipBlockProps) {
  const editable = useDawStore(
    (s) =>
      !isShareProjectKey(s.projectPath) ||
      hasShareCapability(s.shareCapabilities, "edit"),
  );
  const rollDragRef = useRef<RollDrag | null>(null);
  const bodyRef = useRef<BodyDrag | null>(null);
  const bodyMovedRef = useRef(false);
  const pointerHandledRef = useRef(false);
  const bodyCallbacks = useRef({ onMoveCancel, onBodyEnd, onRangeGesture });
  bodyCallbacks.current = { onMoveCancel, onBodyEnd, onRangeGesture };
  /** A move is pressed against the session start, a clip's hard limit. */
  const bodyAtLimit = useRef(false);
  const [bodyBumped, setBodyBumped] = useState(false);
  const markBodyLimit = useCallback((limited: boolean) => {
    if (limited === bodyAtLimit.current) return;
    bodyAtLimit.current = limited;
    setBodyBumped(limited);
    if (limited)
      useDawStore
        .getState()
        .announceStatus(`${HIT_KINDS.clip.label} is at its limit`);
  }, []);
  const cancelBodyDrag = useCallback(() => {
    const drag = bodyRef.current;
    if (!drag) return;
    bodyRef.current = null;
    markBodyLimit(false);
    drag.stopListening();
    if (drag.target.hasPointerCapture?.(drag.pointerId))
      drag.target.releasePointerCapture(drag.pointerId);
    if (drag.rangeCandidate) {
      if (drag.started)
        bodyCallbacks.current.onRangeGesture?.(
          "cancel",
          {
            clientX: drag.originX,
            clientY: drag.originY,
          },
          drag,
        );
    } else bodyCallbacks.current.onMoveCancel?.(drag.clip.id);
    bodyCallbacks.current.onBodyEnd?.(drag.clip.id);
  }, [markBodyLimit]);
  useLayoutEffect(() => () => cancelBodyDrag(), [cancelBodyDrag]);

  useLayoutEffect(() => {
    const drag = bodyRef.current;
    if (!drag) return;
    const state = useDawStore.getState();
    if (
      state.projectPath !== drag.projectPath ||
      state.projectEpoch !== drag.projectEpoch ||
      clip.id !== drag.clip.id ||
      clip.track_id !== drag.clip.track_id ||
      clip.source_start !== drag.clip.source_start ||
      clip.source_end !== drag.clip.source_end ||
      clip.timeline_start !== drag.clip.timeline_start ||
      (!canMove && !drag.rangeCandidate)
    )
      cancelBodyDrag();
  });

  const ticksRef = useRef<readonly number[]>(EMPTY_ARR);
  const edgeHandles = useClipEdgeHandles({
    clip,
    trackId,
    fadeMaxMs,
    neighborSourceLo,
    neighborSourceHi,
    zoomPxPerSec,
    getTicks: () => ticksRef.current,
    onSelect,
  });
  const { fadePreview, trimPreview } = edgeHandles;
  const ripple = useMemo(
    () =>
      trimPreview ? rippleTrimOf(clip, trimPreview, trimPreview.mode) : null,
    [clip, trimPreview],
  );
  // Every lane the trim ripples draws it from the store; only the clip that
  // published a ripple clears it, so other clips mounting mid-drag cannot.
  const publishedRipple = useRef(false);
  useLayoutEffect(() => {
    const store = useDawStore.getState();
    if (ripple) {
      publishedRipple.current = true;
      store.setRippleTrim(ripple);
    } else if (publishedRipple.current) {
      publishedRipple.current = false;
      store.setRippleTrim(null);
    }
  }, [ripple]);
  useLayoutEffect(
    () => () => {
      if (publishedRipple.current) useDawStore.getState().setRippleTrim(null);
    },
    [],
  );

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
  useLayoutEffect(() => {
    ticksRef.current = ticks;
  }, [ticks]);
  const waveKind = refKind(mediaRef);

  const boundaryGeometry = (...clips: ClipRow[]): BoundaryGeometryClip[] =>
    clips.map(
      ({ id, source_start, source_end, timeline_start, source_id }) => ({
        id,
        source_start,
        source_end,
        timeline_start,
        source_id,
      }),
    );

  const rollIsCurrent = (drag: RollDrag): boolean => {
    const state = useDawStore.getState();
    if (
      state.projectPath !== drag.projectPath ||
      state.projectEpoch !== drag.projectEpoch
    )
      return false;
    const interval = rollJoinInterval(
      state.projectEditBasis()?.clips.tracks[drag.interval.right.track_id] ??
        [],
      drag.interval.left.id,
      drag.interval.right.id,
    );
    if (
      !interval ||
      interval.lo !== drag.interval.lo ||
      interval.hi !== drag.interval.hi
    )
      return false;
    return boundaryGeometry(interval.left, interval.right).every(
      (clip, index) => {
        const captured = drag.expectedGeometry[index];
        return (
          captured !== undefined &&
          clip.id === captured.id &&
          clip.source_start === captured.source_start &&
          clip.source_end === captured.source_end &&
          clip.timeline_start === captured.timeline_start &&
          clip.source_id === captured.source_id
        );
      },
    );
  };

  const commitRoll = async (state: RollDrag, clientX: number) => {
    const dxSec = (clientX - state.originX) / zoomPxPerSec;
    const delta = clampToRollInterval(dxSec, state.interval);
    try {
      // A click (under the drag threshold) only selects; a roll the clamp
      // shrinks under ROLL_COMMIT_MIN_PX is a no-op.
      if (
        !useDawStore.getState().joinMutationInFlight &&
        rollIsCurrent(state) &&
        isHandleDrag(state.originX, clientX) &&
        Math.abs(delta) * zoomPxPerSec >= ROLL_COMMIT_MIN_PX
      ) {
        const path = state.projectPath;
        const target: BoundaryTarget = {
          kind: "roll",
          left_clip_id: state.interval.left.id,
          right_clip_id: state.interval.right.id,
        };
        await trackEditSave(
          path,
          (async () => {
            const context = await loadBoundaryContext(
              path,
              target,
              state.expectedGeometry,
            );
            if (
              useDawStore.getState().joinMutationInFlight ||
              !rollIsCurrent(state)
            )
              return;
            await rollClipJoin(
              path,
              state.interval.left.id,
              state.interval.right.id,
              delta,
              context.token,
            );
          })(),
        );
      }
    } finally {
      rollDragRef.current = null;
      onRollPreview(null);
    }
  };

  const startRollDrag = (e: ReactPointerEvent) => {
    if (
      !editable ||
      !prevClip ||
      edgeHandles.active ||
      useDawStore.getState().joinMutationInFlight
    ) {
      return;
    }
    const project = useDawStore.getState();
    const interval = rollJoinInterval(
      project.projectEditBasis()?.clips.tracks[clip.track_id] ?? [],
      prevClip.id,
      clip.id,
    );
    if (!interval) return;
    e.stopPropagation();
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // optional
    }
    rollDragRef.current = {
      originX: e.clientX,
      interval,
      expectedGeometry: boundaryGeometry(interval.left, interval.right),
      projectPath: project.projectPath,
      projectEpoch: project.projectEpoch,
    };
    onRollPreview({
      leftClipId: prevClip.id,
      rightClipId: clip.id,
      deltaSec: 0,
    });
    onSelect(clip.id);
  };

  const onDragMove = (e: ReactPointerEvent) => {
    const d = rollDragRef.current;
    if (!d) {
      return;
    }
    if (!rollIsCurrent(d)) {
      rollDragRef.current = null;
      onRollPreview(null);
      return;
    }
    const dxSec = (e.clientX - d.originX) / zoomPxPerSec;
    onRollPreview({
      leftClipId: d.interval.left.id,
      rightClipId: d.interval.right.id,
      deltaSec: clampToRollInterval(dxSec, d.interval),
    });
  };

  const onDragUp = (e: ReactPointerEvent) => {
    const d = rollDragRef.current;
    if (d) void commitRoll(d, e.clientX);
  };

  const extraTicks = () => waveformTicksToTimeline(clip, ticks);

  const onBodyDown = (e: ReactPointerEvent) => {
    if (
      bodyRef.current ||
      rollDragRef.current ||
      bladeMode ||
      !interactive ||
      edgeHandles.active ||
      (e.pointerType === "mouse" && e.button !== 0)
    ) {
      return;
    }
    e.stopPropagation();
    pointerHandledRef.current = true;
    const mods: ClipSelectMods = {
      shift: e.shiftKey,
      mod: e.metaKey || e.ctrlKey,
    };
    const wasSelected = selected;
    const rangeCandidate = e.shiftKey && Boolean(onRangeGesture);
    const ownsGesture =
      (canMove || rangeCandidate) &&
      !useDawStore.getState().joinMutationInFlight;
    if (ownsGesture && onBodyStart?.(clip.id) === false) return;
    if (!rangeCandidate) {
      if (wasSelected) onSelect(clip.id);
      else onSelectClip?.(clip.id, mods);
    }
    if (
      (!canMove && !rangeCandidate) ||
      useDawStore.getState().joinMutationInFlight
    )
      return;
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // optional
    }
    const target = e.currentTarget as HTMLElement;
    const onOwnedKey = (event: KeyboardEvent) => {
      if (
        ![
          "Escape",
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
          "Enter",
          " ",
        ].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") cancelBodyDrag();
    };
    document.addEventListener("keydown", onOwnedKey, true);
    window.addEventListener("blur", cancelBodyDrag);
    bodyMovedRef.current = false;
    bodyRef.current = {
      clip,
      projectPath: useDawStore.getState().projectPath,
      projectEpoch: useDawStore.getState().projectEpoch,
      target,
      stopListening: () => {
        document.removeEventListener("keydown", onOwnedKey, true);
        window.removeEventListener("blur", cancelBodyDrag);
      },
      rangeCandidate,
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
      if (d.rangeCandidate)
        onRangeGesture?.(
          "start",
          { clientX: d.originX, clientY: d.originY },
          d,
        );
    }
    if (d.rangeCandidate) {
      onRangeGesture?.("move", e, d);
      return;
    }
    const deltaSec = (e.clientX - d.originX) / zoomPxPerSec;
    markBodyLimit(clip.timeline_start + deltaSec < 0);
    onMovePreview?.(clip.id, {
      deltaSec,
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
    if (cancelled) {
      cancelBodyDrag();
      return;
    }
    bodyRef.current = null;
    markBodyLimit(false);
    d.stopListening();
    bodyCallbacks.current.onBodyEnd?.(d.clip.id);
    if (d.rangeCandidate) {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      if (d.started) onRangeGesture?.(cancelled ? "cancel" : "end", e, d);
      else if (!cancelled) onSelectClip?.(clip.id, d.mods);
      return;
    }
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    if (
      cancelled ||
      !d.started ||
      useDawStore.getState().joinMutationInFlight
    ) {
      onMoveCancel?.(d.clip.id);
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
    if (rollDragRef.current) return;
    if (handle === "roll") return startRollDrag(e);
    return edgeHandles.onPointerDown(handle, e);
  };

  const hitHandlers: ClipHitHandlers = {
    onPointerDown: onBodyDown,
    onPointerMove: onBodyMove,
    onPointerUp: (e) => endBodyDrag(e, false),
    onPointerCancel: (e) => endBodyDrag(e, true),
    onLostPointerCapture: (e) => endBodyDrag(e, true),
    onBlur: cancelBodyDrag,
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
      trackSpeaker={trackSpeaker}
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
      onHandlePointerMove={(e) => {
        onDragMove(e);
        edgeHandles.onPointerMove(e);
      }}
      onHandlePointerUp={(e) => {
        onDragUp(e);
        edgeHandles.onPointerUp(e);
      }}
      onHandlePointerCancel={edgeHandles.onPointerCancel}
      onHandleFocus={edgeHandles.onFocus}
      onHandleBlur={edgeHandles.onBlur}
      onHandleKeyDown={edgeHandles.onKeyDown}
      onHandleKeyUp={edgeHandles.onKeyUp}
      bumpedHandle={bodyBumped ? "clip" : edgeHandles.bumped}
    />
  );
}

/** Re-renders only when its own props change (see `TrackLane`). */
export const ClipBlock = memo(ClipBlockLive);
