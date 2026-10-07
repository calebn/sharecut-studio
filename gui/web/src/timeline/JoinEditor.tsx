import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { clampClipFades } from "../edit/fadeLimits";
import { joinGlyph, joinVisual } from "../edit/joinRender";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type { ClipRow } from "../types/project";
import { useResizeObserver } from "../ui";
import { isLabEnabled, useLabFlag } from "../utils/labFlags";
import { useStableCallback } from "../utils/useStableCallback";
import { attachHitRouting, type HitRouter } from "./hitRouting";
import { hitTargetProps } from "./hitTargets";
import { JoinBadgeView } from "./JoinBadge";
import { JoinBlend } from "./JoinBlend";
import { JoinPopover } from "./JoinPopover";
import { announceArmed } from "./touchGrammar";
import { useJoinEdit } from "./useJoinEdit";
import { useTouchPress } from "./useTouchPress";

interface JoinEditorProps {
  left: ClipRow;
  right: ClipRow;
  seamSec: number;
  zoomPxPerSec: number;
  trackFadeMaxMs: number | null;
  rolling?: boolean;
}
function JoinEditorLive(props: JoinEditorProps) {
  const { left, right, seamSec, zoomPxPerSec, trackFadeMaxMs } = props;
  const anchorRef = useRef<HTMLButtonElement>(null),
    railRef = useRef<HTMLDivElement>(null);
  const gripRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const { open, setOpenJoinId } = useDaw((s) => ({
    open: s.openJoinId === right.id,
    setOpenJoinId: s.setOpenJoinId,
  }));
  const edit = useJoinEdit(props);
  const close = useCallback(() => {
    if (useDawStore.getState().openJoinId === right.id) setOpenJoinId(null);
  }, [right.id, setOpenJoinId]);
  useEffect(() => close, [close]);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setHost(anchorRef.current?.closest<HTMLElement>(".timeline-area") ?? null);
  }, [open]);
  const draft =
    (edit.state.kind === "pointer" && edit.state.moved) ||
    edit.state.kind === "range";
  const projected =
    draft && joinGlyph(right) === "crossfade"
      ? {
          ...right,
          join_crossfade_ms: edit.value,
          join_crossfade_blocked: null,
        }
      : right;
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
  // The rail sits outside the lanes' router, so it routes its own presses
  // through the same grammar: a finger arms the grip before it drags.
  const touchLab = useLabFlag("touchChooser");
  const [railRouter, setRailRouter] = useState<HitRouter | null>(null);
  const railRootRef = useCallback((rail: HTMLDivElement | null) => {
    railRef.current = rail;
    if (!rail) return;
    const router = attachHitRouting(rail, {
      touchLab: () => isLabEnabled("touchChooser"),
      onArm: announceArmed,
    });
    setRailRouter(router);
    return () => {
      railRef.current = null;
      router.dispose();
      setRailRouter(null);
    };
  }, []);
  const railPress = useTouchPress(touchLab ? railRouter : null);
  const reducedOut = clampClipFades(
    edit.value,
    right.fade_out_ms,
    right.source_end - right.source_start,
    trackFadeMaxMs,
  ).outMs;
  const rail =
    open && edit.editable && joinGlyph(right) === "crossfade" && host
      ? createPortal(
          <div
            ref={railRootRef}
            className="join-edit-rail"
            role="group"
            aria-label="Crossfade endpoint editing"
            data-touch-press={touchLab ? "" : undefined}
            {...(touchLab ? railPress : {})}
          >
            <span className="join-edit-caption">
              Join at {seamSec}s · {draft ? "Draft" : "Effective"} overlap{" "}
              {draft
                ? edit.value
                : right.join_crossfade_blocked
                  ? 0
                  : (right.join_crossfade_ms ?? 0)}{" "}
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
      <JoinBlend visual={visual} />
      <JoinBadgeView
        ref={anchorRef}
        clipId={right.id}
        glyph={joinGlyph(right)}
        blocked={visual.kind === "blocked"}
        seamSec={seamSec}
        zoomPxPerSec={zoomPxPerSec}
        expanded={open}
        popoverId={id}
        onClick={() => {
          if (useDawStore.getState().joinMutationInFlight) return;
          if (open) {
            edit.cancel();
            close();
          } else setOpenJoinId(right.id);
        }}
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
          right={right}
          seamSec={seamSec}
          trackFadeMaxMs={trackFadeMaxMs}
          anchorRef={anchorRef}
          railRef={railRef}
          edit={edit}
          onClose={close}
        />
      ) : null}
    </>
  );
}
export const JoinEditor = memo(JoinEditorLive);
