import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { setClipJoin } from "../api";
import { joinLengthMaxMs } from "../edit/fadeLimits";
import { type JoinGlyph, joinGlyph, joinLengthMs } from "../edit/joinRender";
import { canApplyPass12 } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type { ClipRow } from "../types/project";
import { errorMessage } from "../utils/apiError";

interface Capture {
  stamp: string;
  epoch: number;
  path: string;
  saved: number;
  max: number;
  min: number;
  zoom: number;
  mode: JoinGlyph;
}
export type JoinEditState =
  | { kind: "idle" }
  | {
      kind: "pointer";
      capture: Capture;
      value: number;
      pointerId: number;
      startX: number;
      moved: boolean;
      target: HTMLButtonElement;
    }
  | { kind: "range"; capture: Capture; value: number }
  | { kind: "submitting"; epoch: number }
  | { kind: "failed"; message: string };

function rowStamp(row: ClipRow) {
  return [
    row.id,
    row.track_id,
    row.origin_track_id,
    row.source_id,
    row.source_start,
    row.source_end,
    row.timeline_start,
    row.timeline_end,
    row.fade_in_ms,
    row.fade_out_ms,
    row.join_in_mode,
    row.join_left_clip_id,
    row.join_crossfade_ms,
    row.join_crossfade_blocked,
  ];
}
export function useJoinEdit({
  left,
  right,
  trackFadeMaxMs,
  zoomPxPerSec,
  rolling = false,
}: {
  left: ClipRow;
  right: ClipRow;
  trackFadeMaxMs: number | null;
  zoomPxPerSec: number;
  rolling?: boolean;
}) {
  const { projectPath, projectEpoch, guestMode, shareCapabilities } = useDaw(
    (s) => ({
      projectPath: s.projectPath,
      projectEpoch: s.projectEpoch,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
    }),
  );
  const editable =
    canApplyPass12(projectPath, guestMode, shareCapabilities) && !rolling;
  const max = joinLengthMaxMs(
    {
      durationSec: left.source_end - left.source_start,
      fadeInMs: left.fade_in_ms,
    },
    { durationSec: right.source_end - right.source_start },
    trackFadeMaxMs,
  );
  const mode = joinGlyph(right),
    min = mode === "crossfade" ? 1 : 0;
  const saved = Math.min(max, Math.max(min, joinLengthMs(left, right)));
  const [state, setState] = useState<JoinEditState>({ kind: "idle" });
  const stateRef = useRef(state);
  const update = useCallback((next: JoinEditState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const mounted = useRef(true);
  const latest = useRef({ left, right, trackFadeMaxMs, zoomPxPerSec, rolling });
  useLayoutEffect(() => {
    latest.current = { left, right, trackFadeMaxMs, zoomPxPerSec, rolling };
  });
  const canonical = () => {
    const s = useDawStore.getState(),
      p = latest.current;
    const entry = Object.entries(s.project?.clips.tracks ?? {}).find(
      ([, rows]) => rows.some((c) => c.id === p.right.id),
    );
    if (!entry) return false;
    const [trackId, rows] = entry,
      i = rows.findIndex((c) => c.id === p.right.id);
    const l = rows[i - 1],
      r = rows[i];
    const cap =
      s.project?.tracks.find((t) => t.id === trackId)?.fade_max_ms ?? null;
    return (
      !!l &&
      !!r &&
      cap === p.trackFadeMaxMs &&
      JSON.stringify(rowStamp(l)) === JSON.stringify(rowStamp(p.left)) &&
      JSON.stringify(rowStamp(r)) === JSON.stringify(rowStamp(p.right))
    );
  };
  const contextStamp = (p: typeof latest.current) => {
    const s = useDawStore.getState();
    const tracks = s.project?.clips.tracks ?? {};
    const pair = Object.values(tracks).find((rows) =>
      rows.some((c) => c.id === p.right.id),
    );
    const i = pair?.findIndex((c) => c.id === p.right.id) ?? -1;
    const l = i > 0 ? pair?.[i - 1] : undefined,
      r = i >= 0 ? pair?.[i] : undefined;
    return JSON.stringify([
      s.projectPath,
      s.projectEpoch,
      s.zoomPxPerSec,
      s.guestMode,
      s.shareCapabilities,
      p.trackFadeMaxMs,
      p.zoomPxPerSec,
      p.rolling,
      rowStamp(p.left),
      rowStamp(p.right),
      l ? rowStamp(l) : null,
      r ? rowStamp(r) : null,
    ]);
  };
  const stamp = () => contextStamp(latest.current);
  const currentStamp = contextStamp({
    left,
    right,
    trackFadeMaxMs,
    zoomPxPerSec,
    rolling,
  });
  const suppressClick = useRef(false);
  const cancel = useCallback(() => {
    const current = stateRef.current;
    if (current.kind !== "pointer" && current.kind !== "range") return;
    update({ kind: "idle" });
    if (
      current.kind === "pointer" &&
      current.target.hasPointerCapture?.(current.pointerId)
    )
      current.target.releasePointerCapture(current.pointerId);
  }, [update]);
  useEffect(
    () =>
      useDawStore.subscribe((next) => {
        if (
          next.projectEpoch !== projectEpoch ||
          next.projectPath !== projectPath
        ) {
          cancel();
          update({ kind: "idle" });
        }
      }),
    [projectEpoch, projectPath, update, cancel],
  );
  useEffect(() => {
    const current = stateRef.current;
    if (
      (current.kind === "pointer" || current.kind === "range") &&
      current.capture.stamp !== currentStamp
    )
      cancel();
  }, [currentStamp, cancel, update]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, [cancel]);
  useEffect(() => {
    window.addEventListener("resize", cancel);
    window.addEventListener("scroll", cancel, true);
    return () => {
      window.removeEventListener("resize", cancel);
      window.removeEventListener("scroll", cancel, true);
    };
  }, [cancel]);
  const capture = (): Capture => ({
    stamp: stamp(),
    epoch: useDawStore.getState().projectEpoch,
    path: useDawStore.getState().projectPath,
    saved,
    max,
    min,
    zoom: zoomPxPerSec,
    mode,
  });
  const valid = (c: Capture) =>
    canonical() &&
    c.stamp === stamp() &&
    canApplyPass12(
      useDawStore.getState().projectPath,
      useDawStore.getState().guestMode,
      useDawStore.getState().shareCapabilities,
    ) &&
    !latest.current.rolling;
  const submit = async (
    nextMode: JoinGlyph,
    value: number | null,
    c: Capture,
  ) => {
    const store = useDawStore.getState();
    if (!valid(c) || store.joinMutationInFlight) return cancel();
    if (
      value != null &&
      (value < c.min ||
        value > c.max ||
        (value === left.fade_out_ms && value === right.fade_in_ms))
    ) {
      cancel();
      return;
    }
    update({ kind: "submitting", epoch: c.epoch });
    store.setJoinMutationInFlight(true);
    try {
      await setClipJoin(c.path, left.id, right.id, nextMode, value);
      if (mounted.current && useDawStore.getState().projectEpoch === c.epoch)
        update({ kind: "idle" });
    } catch (e) {
      if (mounted.current && useDawStore.getState().projectEpoch === c.epoch)
        update({ kind: "failed", message: errorMessage(e) });
    } finally {
      if (useDawStore.getState().projectEpoch === c.epoch)
        useDawStore.getState().setJoinMutationInFlight(false);
    }
  };
  const commitRange = useEffectEvent((value: number) => {
    const current = stateRef.current;
    if (current.kind === "range")
      void submit(current.capture.mode, value, current.capture);
  });
  useEffect(() => {
    if (!input) return;
    const commit = () => commitRange(Number(input.value));
    input.addEventListener("change", commit);
    return () => input.removeEventListener("change", commit);
  }, [input]);
  const value =
    state.kind === "pointer" || state.kind === "range" ? state.value : saved;
  return {
    state,
    editable,
    max,
    min,
    saved,
    value,
    busy: state.kind === "submitting",
    error: state.kind === "failed" ? state.message : null,
    cancel,
    changeMode: (next: JoinGlyph) => {
      cancel();
      if (next !== mode && editable && canonical())
        void submit(next, null, capture());
    },
    rangeProps: {
      ref: setInput,
      value,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        if (
          !editable ||
          !canonical() ||
          stateRef.current.kind === "submitting" ||
          useDawStore.getState().joinMutationInFlight
        )
          return;
        const current = stateRef.current;
        const c = current.kind === "range" ? current.capture : capture();
        update({
          kind: "range",
          capture: c,
          value: Number(e.currentTarget.value),
        });
      },
      onPointerCancel: cancel,
      onBlur: cancel,
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Escape") cancel();
      },
    },
    pointerProps: {
      onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
        if (
          e.button !== 0 ||
          e.isPrimary === false ||
          !editable ||
          !canonical() ||
          mode !== "crossfade" ||
          max <= min ||
          stateRef.current.kind === "submitting" ||
          useDawStore.getState().joinMutationInFlight
        )
          return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.focus();
        const c = capture();
        e.currentTarget.setPointerCapture(e.pointerId);
        update({
          kind: "pointer",
          capture: c,
          value: c.saved,
          pointerId: e.pointerId,
          startX: e.clientX,
          moved: false,
          target: e.currentTarget,
        });
      },
      onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => {
        const current = stateRef.current;
        if (current.kind !== "pointer" || current.pointerId !== e.pointerId)
          return;
        if (!valid(current.capture)) {
          cancel();
          return;
        }
        if (!current.moved && Math.abs(e.clientX - current.startX) < 3) return;
        const value = Math.min(
          current.capture.max,
          Math.max(
            current.capture.min,
            Math.round(
              current.capture.saved +
                (2 * (e.clientX - current.startX) * 1000) /
                  current.capture.zoom,
            ),
          ),
        );
        update({ ...current, value, moved: true });
      },
      onPointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => {
        const current = stateRef.current;
        if (current.kind !== "pointer" || current.pointerId !== e.pointerId)
          return;
        const moved =
          current.moved || Math.abs(e.clientX - current.startX) >= 3;
        suppressClick.current = moved;
        if (moved) {
          const value = Math.min(
            current.capture.max,
            Math.max(
              current.capture.min,
              Math.round(
                current.capture.saved +
                  (2 * (e.clientX - current.startX) * 1000) /
                    current.capture.zoom,
              ),
            ),
          );
          void submit(current.capture.mode, value, current.capture);
        } else cancel();
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      },
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
      onClick: () => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        input?.focus();
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
        if (e.key === "Escape") cancel();
      },
    },
  };
}
export type JoinEdit = ReturnType<typeof useJoinEdit>;
