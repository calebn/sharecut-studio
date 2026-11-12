import {
  memo,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { runPointerCommand } from "../commands/pointer";
import { type RollPreview } from "../edit/clipEdgePreview";
import {
  type ClipMovePointerInfo,
  type ClipSelectMods,
  waveformTicksToTimeline,
} from "../edit/clipMove";
import { rippleTrimOf } from "../edit/ripplePreview";
import { MOVE_THRESHOLD_PX } from "../hooks/gestureConstants";
import { useSnapTicks, useSplitGuideOnClip } from "../hooks/useSnapTicks";
import { hasShareCapability, isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useCoachTip } from "../system/useCoachTip";
import type { ClipRow } from "../types/project";
import { EMPTY_ARR } from "../utils/empty";
import { useStableCallback } from "../utils/useStableCallback";
import {
  clipDrawsPieces,
  clipMediaStartSec,
  clipWaveformGainDb,
} from "../waveform/mediaRef";
import { type MediaRef, refKind } from "../waveform/types";
import { ClipBlockView, type ClipHitHandlers } from "./ClipBlockView";
import { clipBlockGeometry } from "./clipBlockGeometry";
import { useHitRouter } from "./hitRouterContext";
import { HIT_KINDS } from "./inputContract";
import { PieceWaveforms } from "./PieceWaveforms";
import { snapActive } from "./snapOverlay";
import { useHoldTimelineMetrics } from "./timelineMetrics";
import { useClipEdgeHandles } from "./useClipEdgeHandles";
import type { RangeGesture } from "./useRangeGesture";
import { isSplitModifier } from "./useSplitAtPointer";
import { WaveformLayer } from "./WaveformLayer";

export interface ClipBlockProps {
  onRangeGesture?: RangeGesture;
  clip: ClipRow;
  trackId: string;
  role: string;
  /** Track name; shown on the clip label only where the header rail is too
   *  narrow to name the lane (phone). */
  trackLabel?: string;
  /** Speaker identity from the clip's origin track, for labels and names. */
  trackSpeaker?: string;
  zoomPxPerSec: number;
  color: string;
  selected: boolean;
  /** Media the clip draws (`waveform/mediaRef.clipMediaRef`). */
  mediaRef: MediaRef;
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
  /** Select-only (e.g. fade drag start). Callbacks take the clip id first,
   *  so a lane passes one stable function to every clip. */
  onSelect: (clipId: string) => void;
  /** Body click with Shift/Mod modifiers. */
  onSelectClip?: (clipId: string, mods: ClipSelectMods) => void;
  /** Host or share `edit` — not the host-only handle check. */
  canMove?: boolean;
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
  color,
  selected,
  mediaRef,
  nextClip,
  neighborSourceLo,
  neighborSourceHi,
  rollPreview,
  onSelect,
  onSelectClip,
  canMove = false,
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
  const trimCoach = useCoachTip("trim");
  const { release: releaseTrimCoach } = trimCoach;
  useEffect(() => {
    if (moving) releaseTrimCoach();
  }, [moving, releaseTrimCoach]);
  const bodyRef = useRef<BodyDrag | null>(null);
  const bodyMovedRef = useRef(false);
  const pointerHandledRef = useRef(false);
  const router = useHitRouter();
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
  const cancelBodyDrag = useStableCallback(() => {
    const drag = bodyRef.current;
    if (!drag) return;
    bodyRef.current = null;
    markBodyLimit(false);
    drag.stopListening();
    if (drag.target.hasPointerCapture?.(drag.pointerId))
      drag.target.releasePointerCapture(drag.pointerId);
    router?.disarm(drag.target);
    if (drag.rangeCandidate) {
      if (drag.started)
        onRangeGesture?.(
          "cancel",
          {
            clientX: drag.originX,
            clientY: drag.originY,
          },
          drag,
        );
    } else onMoveCancel?.(drag.clip.id);
    onBodyEnd?.(drag.clip.id);
  });
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
  const waveClipGainDb = clipWaveformGainDb(clip, mediaRef);

  const extraTicks = () => waveformTicksToTimeline(clip, ticks);

  const onBodyDown = (e: ReactPointerEvent) => {
    if (
      bodyRef.current ||
      isSplitModifier(e) ||
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
      else {
        onSelectClip?.(clip.id, mods);
        if (editable) trimCoach.show();
      }
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
      altKey: e.altKey,
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
    onBodyEnd?.(d.clip.id);
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
      altKey: e.altKey,
    });
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
      if (!pointerHandledRef.current) {
        onSelectClip?.(clip.id, {
          shift: e.shiftKey,
          mod: e.metaKey || e.ctrlKey,
        });
      }
      pointerHandledRef.current = false;
    },
    onDoubleClick: (e) => {
      e.stopPropagation();
      runPointerCommand("edit.inspect", { open: true });
    },
  };

  // Ticks still load for the paused playhead (a body move magnets to them),
  // but draw only where they explain an edit: trimming, or the Alt-click Split
  // guide resting on this clip.
  const splitting = useSplitGuideOnClip(clip);
  const snapEnabled = useDawStore((st) => st.snapEnabled);
  const trimSnapping =
    trimPreview != null && snapActive(snapEnabled, edgeHandles.altHeld);
  const drawTicks = trimSnapping || splitting;

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
      nextClip={nextClip}
      showHandles={editable && interactive}
      trimHint={{
        text: trimCoach.text,
        shown: trimCoach.shown,
        onDismiss: trimCoach.dismiss,
        onRelease: trimCoach.release,
      }}
      canMove={canMove}
      moving={moving}
      previewHidden={previewHidden}
      interactive={interactive}
      snapTicks={drawTicks ? ticks : EMPTY_ARR}
      waveform={
        clipDrawsPieces(clip, mediaRef) ? (
          <PieceWaveforms
            pieces={geometry.pieces}
            leftCss={geometry.left}
            zoom={zoomPxPerSec}
            mediaRef={mediaRef}
            kind={waveKind}
            colorVar={color}
            role={role}
            gainDb={gainDb}
            clipGainDb={waveClipGainDb}
          />
        ) : (
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
            clipGainDb={waveClipGainDb}
          />
        )
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
            clipGainDb={waveClipGainDb}
          />
        ) : null
      }
      hitHandlers={interactive ? hitHandlers : undefined}
      onHandlePointerDown={edgeHandles.onPointerDown}
      onHandlePointerMove={edgeHandles.onPointerMove}
      onHandlePointerUp={edgeHandles.onPointerUp}
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
