import {
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { execute } from "../commands/execute";
import {
  type ClipHandleAction,
  registerFocusedClipHandle,
} from "../commands/focusedClipHandle";
import { clampTrimSourceSec, type TrimEdge } from "../edit/clipEdgePreview";
import { saveClipEdge, TRIM_MODE } from "../edit/clipEdgeSave";
import { CLIP_HANDLE_STEPS } from "../edit/clipHandleSteps";
import { isHandleDrag } from "../edit/dragThreshold";
import { clampFadeMs, edgeFadeMaxMs } from "../edit/fadeLimits";
import { nudgeAxis, nudgeStep } from "../edit/nudge";
import { softBoundaries } from "../edit/nudgeBoundaries";
import { trimNeighborBounds } from "../edit/trimLimits";
import { canApplyPass12 } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { ClipRow } from "../types/project";
import { errorMessage } from "../utils/apiError";
import type { ClipHandle } from "./ClipBlockView";
import type { ClipFadePreview, ClipTrimPreview } from "./clipBlockGeometry";
import { HIT_KINDS } from "./inputContract";
import { magnetSec } from "./snapOverlay";

type Context = {
  clip: ClipRow;
  trackId: string;
  fadeMaxMs: number | null;
  neighborSourceLo: number;
  neighborSourceHi: number;
  zoomPxPerSec: number;
  getTicks(): readonly number[];
  onSelect(clipId: string): void;
};
type Capture = Omit<Context, "getTicks" | "onSelect"> & {
  projectPath: string;
  projectEpoch: number;
  ticks: number[];
};
type Input =
  | { kind: "pointer"; pointerId: number; originX: number }
  | { kind: "keyboard"; key: "ArrowLeft" | "ArrowRight" };
type Draft = {
  phase: "preview" | "committing";
  capture: Capture;
  input: Input;
} & (
  | { kind: "fade"; edge: TrimEdge; preview: ClipFadePreview }
  | { kind: "trim"; edge: TrimEdge; preview: ClipTrimPreview }
);

function sameGeometry(a: ClipRow, b: ClipRow): boolean {
  return (
    a.id === b.id &&
    a.track_id === b.track_id &&
    a.origin_track_id === b.origin_track_id &&
    a.source_id === b.source_id &&
    a.source_start === b.source_start &&
    a.source_end === b.source_end &&
    a.timeline_start === b.timeline_start &&
    a.timeline_end === b.timeline_end &&
    a.fade_in_ms === b.fade_in_ms &&
    a.fade_out_ms === b.fade_out_ms &&
    a.join_in_mode === b.join_in_mode
  );
}

/** The lane still gives the clip the bounds the gesture captured. */
function sameTrimBounds(
  lane: readonly ClipRow[],
  index: number,
  capture: Capture,
): boolean {
  const { neighborLo, neighborHi } = trimNeighborBounds(lane, index, TRIM_MODE);
  return (
    neighborLo === capture.neighborSourceLo &&
    neighborHi === capture.neighborSourceHi
  );
}

function projectEdge(draft: Draft, candidate: number): Draft {
  const c = draft.capture;
  const clip = c.clip;
  if (draft.kind === "fade") {
    const other = draft.edge === "in" ? clip.fade_out_ms : clip.fade_in_ms;
    const value = clampFadeMs(
      candidate,
      edgeFadeMaxMs(clip.source_end - clip.source_start, c.fadeMaxMs, other),
    );
    return {
      ...draft,
      preview: {
        edge: draft.edge,
        inMs: draft.edge === "in" ? value : clip.fade_in_ms,
        outMs: draft.edge === "out" ? value : clip.fade_out_ms,
      },
    };
  }
  const value = clampTrimSourceSec(
    draft.edge,
    candidate,
    clip.source_start,
    clip.source_end,
    c.neighborSourceLo,
    c.neighborSourceHi,
  );
  return {
    ...draft,
    preview: {
      edge: draft.edge,
      mode: draft.preview.mode,
      sourceStart: draft.edge === "in" ? value : clip.source_start,
      sourceEnd: draft.edge === "out" ? value : clip.source_end,
    },
  };
}

function pointerCandidate(d: Draft, originX: number, clientX: number): number {
  const delta = (clientX - originX) / d.capture.zoomPxPerSec;
  const clip = d.capture.clip;
  return d.kind === "fade"
    ? d.edge === "in"
      ? clip.fade_in_ms + delta * 1000
      : clip.fade_out_ms - delta * 1000
    : magnetSec(
        (d.edge === "in" ? clip.source_start : clip.source_end) + delta,
        d.capture.ticks,
        d.capture.zoomPxPerSec,
      );
}

export function useClipEdgeHandles(context: Context) {
  const latest = useRef(context);
  useLayoutEffect(() => {
    latest.current = context;
  });
  const draftRef = useRef<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** A held arrow stopped at a soft boundary or limit: the handle it stopped. */
  const [bumped, setBumped] = useState<ClipHandle | null>(null);
  /** The key's auto-repeat stopped; only a fresh press steps on. */
  const keyStopped = useRef(false);
  /** A pointer drag is pressed against a hard limit. */
  const atLimit = useRef(false);
  const focusRef = useRef<{
    handle: ClipHandle;
    element: HTMLButtonElement;
    path: string;
    epoch: number;
    clipId: string;
    trackId: string;
    dispose(): void;
  } | null>(null);
  const mounted = useRef(true);

  const publish = (next: Draft | null) => {
    if (!next && atLimit.current) {
      atLimit.current = false;
      setBumped(null);
    }
    draftRef.current = next;
    if (mounted.current) setDraft(next);
  };
  const cancel = () => {
    if (draftRef.current?.phase === "preview") publish(null);
  };
  const fresh = (capture: Capture) => {
    const s = useDawStore.getState();
    const c = latest.current;
    const lane = s.project?.clips.tracks[capture.clip.track_id] ?? [];
    const index = lane.findIndex((row) => row.id === capture.clip.id);
    const savedClip = lane[index];
    const savedTrack = s.project?.tracks.find(
      (track) => track.id === capture.clip.track_id,
    );
    const savedGeometryMatches =
      s.project == null ||
      (savedClip != null &&
        sameGeometry(savedClip, capture.clip) &&
        savedTrack != null &&
        (savedTrack.fade_max_ms ?? null) === capture.fadeMaxMs &&
        sameTrimBounds(lane, index, capture));
    return (
      mounted.current &&
      !s.joinMutationInFlight &&
      savedGeometryMatches &&
      s.projectPath === capture.projectPath &&
      s.projectEpoch === capture.projectEpoch &&
      canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities) &&
      c.trackId === capture.trackId &&
      sameGeometry(c.clip, capture.clip) &&
      c.fadeMaxMs === capture.fadeMaxMs &&
      c.neighborSourceLo === capture.neighborSourceLo &&
      c.neighborSourceHi === capture.neighborSourceHi
    );
  };
  const begin = (handle: ClipHandle, input: Input): Draft | null => {
    if (handle === "roll" || draftRef.current) return null;
    const s = useDawStore.getState();
    if (
      s.joinMutationInFlight ||
      !canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities)
    )
      return null;
    const c = latest.current;
    const capture: Capture = {
      clip: c.clip,
      trackId: c.trackId,
      fadeMaxMs: c.fadeMaxMs,
      neighborSourceLo: c.neighborSourceLo,
      neighborSourceHi: c.neighborSourceHi,
      zoomPxPerSec: c.zoomPxPerSec,
      ticks: [...c.getTicks()],
      projectPath: s.projectPath,
      projectEpoch: s.projectEpoch,
    };
    if (!fresh(capture)) return null;
    const edge = handle.endsWith("in") ? "in" : "out";
    const next: Draft = handle.startsWith("fade")
      ? {
          phase: "preview",
          kind: "fade",
          edge,
          capture,
          input,
          preview: { edge, inMs: c.clip.fade_in_ms, outMs: c.clip.fade_out_ms },
        }
      : {
          phase: "preview",
          kind: "trim",
          edge,
          capture,
          input,
          preview: {
            edge,
            mode: TRIM_MODE,
            sourceStart: c.clip.source_start,
            sourceEnd: c.clip.source_end,
          },
        };
    publish(next);
    c.onSelect(c.clip.id);
    return next;
  };
  const update = (d: Draft, candidate: number) => {
    if (!fresh(d.capture)) {
      publish(null);
      return;
    }
    publish(projectEdge(d, candidate));
  };
  /**
   * A pointer drag to `candidate`: past a hard limit (the source's start or
   * end, a neighbour, a fade's clip) it stops there, with the strip's bump
   * and note, as a held nudge does (#1135).
   */
  const drag = (d: Draft, candidate: number) => {
    const next = projectEdge(d, candidate);
    const value =
      next.kind === "fade"
        ? next.edge === "in"
          ? next.preview.inMs
          : next.preview.outMs
        : next.edge === "in"
          ? next.preview.sourceStart
          : next.preview.sourceEnd;
    const limited = Math.abs(value - candidate) > 1e-6;
    if (limited !== atLimit.current) {
      atLimit.current = limited;
      const handle: ClipHandle = `${d.kind}-${d.edge}`;
      setBumped(limited ? handle : null);
      if (limited) {
        useDawStore
          .getState()
          .announceStatus(`${HIT_KINDS[handle].label} is at its limit`);
      }
    }
    update(d, candidate);
  };
  const finish = async () => {
    const d = draftRef.current;
    if (!d || d.phase !== "preview") return;
    if (!fresh(d.capture)) {
      publish(null);
      return;
    }
    const c = d.capture;
    const clip = c.clip;
    const changed =
      d.kind === "fade"
        ? d.preview.inMs !== clip.fade_in_ms ||
          d.preview.outMs !== clip.fade_out_ms
        : Math.abs(d.preview.sourceStart - clip.source_start) > 1e-9 ||
          Math.abs(d.preview.sourceEnd - clip.source_end) > 1e-9;
    if (!changed) {
      publish(null);
      return;
    }
    const owner: Draft = { ...d, phase: "committing" };
    publish(owner);
    try {
      const saved = await saveClipEdge(
        c.projectPath,
        clip,
        d.kind === "fade"
          ? { kind: "fade", inMs: d.preview.inMs, outMs: d.preview.outMs }
          : {
              kind: "trim",
              edge: d.edge,
              mode: d.preview.mode,
              sourceSec:
                d.edge === "in" ? d.preview.sourceStart : d.preview.sourceEnd,
            },
        () => fresh(c),
      );
      if (!saved) return;
      if (fresh(c))
        useDawStore
          .getState()
          .announceStatus(d.kind === "fade" ? "Fade saved" : "Trim saved");
    } catch (error) {
      if (fresh(c))
        useDawStore
          .getState()
          .announceStatus(`Clip edit failed: ${errorMessage(error)}`);
    } finally {
      if (draftRef.current === owner) publish(null);
    }
  };
  const run = (handle: ClipHandle, action: ClipHandleAction) => {
    const focus = focusRef.current;
    const s = useDawStore.getState();
    const c = latest.current;
    if (
      !focus ||
      focus.handle !== handle ||
      focus.path !== s.projectPath ||
      focus.epoch !== s.projectEpoch ||
      focus.clipId !== c.clip.id ||
      focus.trackId !== c.trackId
    ) {
      return { status: "disabled" as const, reason: "Clip focus changed" };
    }
    if (action.phase === "finish") {
      const d = draftRef.current;
      if (
        d?.input.kind !== "keyboard" ||
        (action.key && action.key !== d.input.key)
      )
        return { status: "ok" as const };
      return finish().then(() => ({ status: "ok" as const }));
    }
    const key = action.direction === -1 ? "ArrowLeft" : "ArrowRight";
    if (!draftRef.current) keyStopped.current = false;
    const d = draftRef.current ?? begin(handle, { kind: "keyboard", key });
    if (!d || d.phase !== "preview" || d.input.kind !== "keyboard")
      return { status: "disabled" as const, reason: "Clip edit in progress" };
    const current =
      d.kind === "fade"
        ? d.edge === "in"
          ? d.preview.inMs
          : d.preview.outMs
        : d.edge === "in"
          ? d.preview.sourceStart
          : d.preview.sourceEnd;
    const step = CLIP_HANDLE_STEPS[d.kind][action.shift ? "large" : "small"];
    const direction =
      d.kind === "fade" && d.edge === "out"
        ? -action.direction
        : action.direction;
    // The strip's held nudges and these keys share one step: hard limits
    // always stop it, and a held key stops at a soft boundary that a fresh
    // press then crosses (#1115).
    if (action.held && keyStopped.current) return { status: "ok" as const };
    keyStopped.current = false;
    const project = s.project;
    const axis = project
      ? nudgeAxis(project, {
          kind: d.kind,
          trackId: c.trackId,
          clipId: c.clip.id,
          edge: d.edge,
        })
      : null;
    if (!project || !axis) {
      update(d, current + direction * step);
      return { status: "ok" as const };
    }
    const boundaries = axis.mover
      ? softBoundaries(project, axis.mover, useDawStore.getState().playheadSec)
      : [];
    const next = nudgeStep(
      axis,
      boundaries,
      current,
      direction * step,
      action.held,
    );
    update(d, next.value);
    if (next.stop && action.held) {
      keyStopped.current = true;
      setBumped(handle);
      const name = HIT_KINDS[handle].label;
      s.announceStatus(
        next.stop.kind === "boundary"
          ? `${name} stopped at ${next.stop.boundary.label}`
          : `${name} is at its limit`,
      );
    }
    return { status: "ok" as const };
  };
  const actions = useRef({ run, cancel });
  useLayoutEffect(() => {
    actions.current = { run, cancel };
  });

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      draftRef.current = null;
      focusRef.current?.dispose();
      focusRef.current = null;
    };
  }, []);
  const path = useDawStore((s) => s.projectPath);
  const epoch = useDawStore((s) => s.projectEpoch);
  useLayoutEffect(() => {
    const focus = focusRef.current;
    if (
      focus &&
      (!focus.element.isConnected || document.activeElement !== focus.element)
    ) {
      focus.dispose();
      focusRef.current = null;
    } else if (focus) {
      focus.path = path;
      focus.epoch = epoch;
      focus.clipId = context.clip.id;
      focus.trackId = context.trackId;
    }
    if (draftRef.current && !fresh(draftRef.current.capture)) publish(null);
  });

  const command = (handle: ClipHandle) =>
    handle.startsWith("fade") ? "edit.setClipFade" : "edit.trimClipEdge";
  return {
    bumped,
    fadePreview: draft?.kind === "fade" ? draft.preview : null,
    trimPreview: draft?.kind === "trim" ? draft.preview : null,
    active: draft != null,
    onFocus: (handle: ClipHandle, event: FocusEvent<HTMLButtonElement>) => {
      if (handle === "roll") return;
      const s = useDawStore.getState();
      focusRef.current?.dispose();
      const dispose = registerFocusedClipHandle({
        kind: handle.startsWith("fade") ? "fade" : "trim",
        run: (action) => actions.current.run(handle, action),
        cancel: () => actions.current.cancel(),
      });
      focusRef.current = {
        handle,
        element: event.currentTarget,
        path: s.projectPath,
        epoch: s.projectEpoch,
        clipId: context.clip.id,
        trackId: context.trackId,
        dispose,
      };
    },
    onBlur: (handle: ClipHandle) => {
      if (focusRef.current?.handle !== handle) return;
      void execute(command(handle), { phase: "finish" });
      focusRef.current.dispose();
      focusRef.current = null;
    },
    onKeyUp: (handle: ClipHandle, event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        setBumped(null);
        void execute(command(handle), { phase: "finish", key: event.key });
      }
    },
    onKeyDown: (
      _handle: ClipHandle,
      event: KeyboardEvent<HTMLButtonElement>,
    ) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    },
    onPointerDown: (
      handle: ClipHandle,
      event: PointerEvent<HTMLButtonElement>,
    ) => {
      event.stopPropagation();
      event.preventDefault();
      cancel();
      const d = begin(handle, {
        kind: "pointer",
        pointerId: event.pointerId,
        originX: event.clientX,
      });
      if (!d) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}
    },
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
      const d = draftRef.current;
      if (
        !d ||
        d.phase !== "preview" ||
        d.input.kind !== "pointer" ||
        d.input.pointerId !== event.pointerId
      )
        return;
      drag(d, pointerCandidate(d, d.input.originX, event.clientX));
    },
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {
      const d = draftRef.current;
      if (
        !d ||
        d.input.kind !== "pointer" ||
        d.input.pointerId !== event.pointerId
      )
        return;
      if (!isHandleDrag(d.input.originX, event.clientX)) {
        cancel();
        return;
      }
      update(d, pointerCandidate(d, d.input.originX, event.clientX));
      void finish();
    },
    onPointerCancel: () => {
      cancel();
    },
  };
}
