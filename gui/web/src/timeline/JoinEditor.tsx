import {
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { clampClipFades } from "../edit/fadeLimits";
import { joinVisual, projectJoinDraft } from "../edit/joinRender";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type { ClipRow } from "../types/project";
import { useResizeObserver } from "../ui";
import { joinKind } from "../utils/editMarkerRegistry";
import { useStableCallback } from "../utils/useStableCallback";
import type { MediaRef } from "../waveform/types";
import { joinPopoverId } from "./editMarkers";
import { useHitRouter } from "./hitRouterContext";
import { hitTargetProps } from "./hitTargets";
import { JoinBlend, type JoinWaveSides } from "./JoinBlend";
import { JoinPopover } from "./JoinPopover";
import { useJoinEdit } from "./useJoinEdit";
import { useTouchPress } from "./useTouchPress";

interface JoinEditorProps {
  left: ClipRow;
  right: ClipRow;
  seamSec: number;
  zoomPxPerSec: number;
  trackFadeMaxMs: number | null;
  rolling?: boolean;
  leftRef?: MediaRef;
  rightRef?: MediaRef;
  role?: string;
  gainDb?: number;
}

function findJoinGlyph(clipId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-hit-kind="join"][data-hit-id="${CSS.escape(clipId)}"]`,
  );
}

function JoinEditorLive(props: JoinEditorProps) {
  const { left, right, seamSec, zoomPxPerSec, trackFadeMaxMs } = props;
  const { leftRef, rightRef, role, gainDb } = props;
  const waves = useMemo<JoinWaveSides | undefined>(
    () =>
      leftRef && rightRef && role !== undefined && gainDb !== undefined
        ? { leftRef, rightRef, role, gainDb }
        : undefined,
    [leftRef, rightRef, role, gainDb],
  );
  const anchorRef = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return findJoinGlyph(right.id);
      },
    }),
    [right.id],
  );
  const railRef = useRef<HTMLDivElement>(null);
  const gripRef = useRef<HTMLButtonElement>(null);
  const id = joinPopoverId(right.id);
  const { open, setOpenJoinId } = useDaw((s) => ({
    open: s.openJoinId === right.id,
    setOpenJoinId: s.setOpenJoinId,
  }));
  const edit = useJoinEdit(props);
  const close = useCallback(() => {
    if (useDawStore.getState().openJoinId === right.id) setOpenJoinId(null);
  }, [right.id, setOpenJoinId]);
  useEffect(() => close, [close]);
  const cancelEdit = edit.cancel;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) cancelEdit();
    wasOpen.current = open;
  }, [open, cancelEdit]);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) {
      setHost(
        findJoinGlyph(right.id)?.closest<HTMLElement>(".timeline-area") ?? null,
      );
    }
  }, [open, right.id]);
  const draft =
    (edit.state.kind === "pointer" && edit.state.moved) ||
    edit.state.kind === "range";
  const projected = draft ? projectJoinDraft(left, right, edit.value) : right;
  const visual = joinVisual(projected, zoomPxPerSec);
  const [leader, setLeader] = useState<{
    x: number;
    y: number;
    endX: number;
    endY: number;
  } | null>(null);
  const place = useStableCallback(() => {
    const a = anchorRef.current,
      r = railRef.current,
      g = gripRef.current;
    if (!a || !r || !g) {
      setLeader(null);
      return;
    }
    const ab = a.getBoundingClientRect(),
      rb = g.parentElement!.getBoundingClientRect();
    const clip = anchorRef.current
      ?.closest(".lane-row")
      ?.querySelector(".clip-block")
      ?.getBoundingClientRect();
    const x =
      ab.left +
      ab.width / 2 +
      (visual.kind === "blend" ? visual.widthPx / 2 : 0);
    const targetX = Math.max(
      rb.left + g.offsetWidth / 2,
      Math.min(x, rb.right - g.offsetWidth / 2),
    );
    g.style.left = `${targetX - rb.left - g.offsetWidth / 2}px`;
    setLeader({
      x,
      y: clip?.bottom ?? ab.bottom,
      endX: targetX,
      endY: rb.top,
    });
  });
  const spanWidth = visual.kind === "blend" ? visual.widthPx : 0;
  useLayoutEffect(() => {
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [
    place,
    open,
    edit.value,
    zoomPxPerSec,
    host,
    seamSec,
    right.timeline_start,
    spanWidth,
  ]);
  useResizeObserver(railRef, place);
  // The rail sits outside the lanes' root, so the timeline's router adopts
  // it: a finger arms the grip before it drags, and a second finger anywhere
  // rolls the drag back.
  const router = useHitRouter();
  const railRootRef = useCallback(
    (rail: HTMLDivElement | null) => {
      railRef.current = rail;
      if (!rail || !router) return;
      const release = router.adopt(rail);
      return () => {
        railRef.current = null;
        release();
      };
    },
    [router],
  );
  const railPress = useTouchPress(router);
  const reducedOut = clampClipFades(
    edit.value,
    right.fade_out_ms,
    right.source_end - right.source_start,
    trackFadeMaxMs,
  ).outMs;
  const rail =
    open && edit.editable && joinKind(right) === "join-crossfade" && host
      ? createPortal(
          <div
            ref={railRootRef}
            className="join-edit-rail"
            role="group"
            aria-label="Crossfade endpoint editing"
            data-touch-press=""
            {...railPress}
          >
            <span className="join-edit-caption">
              Join at {seamSec}s ·{" "}
              {draft && !projected.join_crossfade_blocked
                ? "Draft"
                : "Effective"}{" "}
              overlap{" "}
              {projected.join_crossfade_blocked
                ? 0
                : (projected.join_crossfade_ms ?? 0)}{" "}
              ms
            </span>
            <div className="join-edit-track">
              <button
                ref={gripRef}
                type="button"
                className="join-length-grip"
                disabled={edit.busy || edit.max <= edit.min}
                aria-label="Drag crossfade right endpoint; press to focus Length"
                {...hitTargetProps(
                  "crossfade-end",
                  right.id,
                  seamSec + edit.value / 2000,
                )}
                {...edit.pointerProps}
              >
                ↔
              </button>
            </div>
            {draft && reducedOut < right.fade_out_ms ? (
              <span className="join-draft-warning" role="status">
                This length also reduces the right clip fade-out to {reducedOut}{" "}
                ms.
              </span>
            ) : null}
          </div>,
          host,
        )
      : null;
  return (
    <>
      <JoinBlend
        visual={visual}
        left={left}
        right={right}
        waves={projected.join_crossfade_blocked ? undefined : waves}
        zoomPxPerSec={zoomPxPerSec}
      />
      {rail}
      {open && leader && rail
        ? createPortal(
            <svg
              className="join-endpoint-leader"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d={`M${leader.x} ${leader.y}L${leader.x} ${leader.y + 8}L${leader.endX} ${leader.endY}`}
              />
            </svg>,
            document.body,
          )
        : null}
      {open ? (
        <JoinPopover
          id={id}
          left={left}
          right={projected}
          seamSec={seamSec}
          trackFadeMaxMs={trackFadeMaxMs}
          anchorRef={anchorRef}
          railRef={railRef}
          gripRef={gripRef}
          edit={edit}
          onClose={close}
        />
      ) : null}
    </>
  );
}
export const JoinEditor = memo(JoinEditorLive);
