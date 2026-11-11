import { useCallback, useMemo, useRef, useState } from "react";
import { updateChapter, updateSocialClip } from "../api";
import { executePointerCommand } from "../commands/pointer";
import { runAndAnnounceRefusal } from "../commands/refusal";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { type MarkerGrip, MarkerLane } from "../system/MarkerLane";
import { type LaneMarker, markerEnd } from "../system/markerLayout";
import type {
  ChapterMarker,
  SocialClipView,
  TimelineComment,
} from "../types/project";
import { MARKER_ROW_HEIGHT } from "../utils/layout";
import { formatTimeShort } from "../utils/time";
import { useStableCallback } from "../utils/useStableCallback";
import type { ClippingFlag } from "./clippingFlags";
import { hitTargetProps } from "./hitTargets";
import { chapterMarkerId, laneMarkers, movedMarker } from "./laneMarkers";

type HeldMove = {
  origin: Extract<LaneMarker, { kind: "chapter" | "clip" }>;
  grip: MarkerGrip;
  delta: number;
  duration: number;
};

function sameSource(
  marker: LaneMarker | undefined,
  origin: HeldMove["origin"],
): boolean {
  return (
    marker?.kind === origin.kind &&
    marker.start === origin.start &&
    markerEnd(marker) === markerEnd(origin)
  );
}

const NO_FLAGS: readonly ClippingFlag[] = [];
const LANE_ANCHOR = presenceAnchorProps(presenceAnchor("markers"));
const CLIPPING_ANCHOR = presenceAnchorProps(
  presenceAnchor("markers", "clipping"),
);

const HIT_KIND = {
  chapter: "chapter",
  clip: "social-clip",
  comment: "comment",
} as const;

export interface MarkerLaneHostProps {
  chapters: readonly ChapterMarker[];
  socialClips: readonly SocialClipView[];
  comments: readonly TimelineComment[];
  selected: readonly string[];
  zoomPxPerSec: number;
  width: number;
  duration: number;
  laneRow: boolean;
  readOnly: boolean;
  onMoveChapter?: (
    chapter: ChapterMarker,
    nextTime: number,
  ) => void | Promise<void>;
  onMoveSocial?: (
    id: string,
    start: number,
    end: number,
  ) => void | Promise<void>;
  onAddChapter?: (seconds: number, title: string) => void | Promise<void>;
  clippingFlags?: readonly ClippingFlag[];
  onSelectChapter: (chapter: ChapterMarker) => void;
  onSelectSocial: (clip: SocialClipView) => void;
  onSelectComment: (comment: TimelineComment) => void;
  onSelectClipping?: (flag: ClippingFlag) => void;
}

export function MarkerLaneHost({
  chapters,
  socialClips,
  comments,
  selected,
  zoomPxPerSec,
  width,
  duration,
  laneRow,
  readOnly,
  onMoveChapter,
  onMoveSocial,
  onAddChapter,
  clippingFlags = NO_FLAGS,
  onSelectChapter,
  onSelectSocial,
  onSelectComment,
  onSelectClipping,
}: MarkerLaneHostProps) {
  const [preview, setPreview] = useState<HeldMove | null>(null);
  const held = useRef<HeldMove | null>(null);
  /** A chapter's id is its time, so a re-grab before its save settles would start from a stale origin. */
  const saving = useRef(new Set<string>());
  const [adding, setAdding] = useState<{ at: number } | null>(null);
  const addable = onAddChapter != null && !readOnly;
  const onAdd = useCallback(
    (seconds: number) => setAdding({ at: seconds }),
    [],
  );
  const onAddCancel = useCallback(() => setAdding(null), []);
  const onAddCommit = useCallback(
    (seconds: number, title: string) => {
      setAdding(null);
      void onAddChapter?.(seconds, title);
    },
    [onAddChapter],
  );
  const authoritativeMarkers = useMemo(
    () =>
      laneMarkers({
        chapters,
        socialClips,
        comments,
      }),
    [chapters, socialClips, comments],
  );
  const markers = useMemo(
    () =>
      authoritativeMarkers.map((marker) =>
        preview &&
        marker.id === preview.origin.id &&
        sameSource(marker, preview.origin)
          ? movedMarker(
              preview.origin,
              preview.grip,
              preview.delta,
              preview.duration,
            )
          : marker,
      ),
    [authoritativeMarkers, preview],
  );
  const onSelect = useStableCallback((id: string) => {
    const chapter = chapters.find((c) => chapterMarkerId(c) === id);
    if (chapter) return onSelectChapter(chapter);
    const clip = socialClips.find((c) => c.id === id);
    if (clip) return onSelectSocial(clip);
    const comment = comments.find((c) => c.id === id);
    if (comment) onSelectComment(comment);
  });

  const commit = useStableCallback(async (move: HeldMove) => {
    saving.current.add(move.origin.id);
    try {
      const source = authoritativeMarkers.find(
        (marker) => marker.id === move.origin.id,
      );
      if (
        readOnly ||
        duration !== move.duration ||
        !sameSource(source, move.origin)
      )
        return;
      const next = movedMarker(
        move.origin,
        move.grip,
        move.delta,
        move.duration,
      );
      if (next.kind === "chapter" && next.start !== move.origin.start) {
        await onMoveChapter?.(
          { time: move.origin.start, title: next.title },
          next.start,
        );
      } else if (
        next.kind === "clip" &&
        (next.start !== move.origin.start ||
          next.end !== markerEnd(move.origin))
      ) {
        await onMoveSocial?.(next.id, next.start, next.end);
      }
    } finally {
      saving.current.delete(move.origin.id);
      setPreview((current) => (current === move ? null : current));
    }
  });

  const hitProps = useCallback(
    (id: string, grip: MarkerGrip) => {
      if (grip !== "move") return undefined;
      const marker = markers.find((m) => m.id === id);
      if (!marker) return undefined;
      return hitTargetProps(HIT_KIND[marker.kind], id, marker.start, {
        selected: selected.includes(id),
        ...(marker.kind === "comment" ? { detail: marker.author } : {}),
      });
    },
    [markers, selected],
  );

  const begin = useStableCallback((id: string, grip: MarkerGrip) => {
    const origin = authoritativeMarkers.find((marker) => marker.id === id);
    if (
      !origin ||
      (origin.kind === "chapter" && saving.current.has(id)) ||
      origin.kind === "comment" ||
      readOnly ||
      duration <= 0
    )
      return null;
    const move: HeldMove = {
      origin,
      grip,
      delta: 0,
      duration,
    };
    held.current = move;
    return move;
  });
  const onDragStart = useCallback(
    (id: string, grip: MarkerGrip) => begin(id, grip) != null,
    [begin],
  );
  const onDrag = useCallback(
    (_id: string, _grip: MarkerGrip, drag: { delta: number }) => {
      const move = held.current;
      if (!move) return;
      const delta =
        move.origin.kind === "chapter"
          ? Math.min(
              Math.max(
                0,
                Math.round((move.origin.start + drag.delta) * 10) / 10,
              ),
              Math.max(0, Math.floor(move.duration * 10) / 10),
            ) - move.origin.start
          : drag.delta;
      const next = { ...move, delta };
      held.current = next;
      setPreview(next);
    },
    [],
  );
  const finish = useCallback(
    (_id: string, _grip: MarkerGrip, committed: boolean) => {
      const move = held.current;
      held.current = null;
      if (!move) return;
      if (committed) void commit(move);
      else setPreview((current) => (current === move ? null : current));
    },
    [commit],
  );
  const onNudge = useCallback(
    (id: string, grip: MarkerGrip, seconds: number) => {
      const move = held.current ?? begin(id, grip);
      if (!move) return;
      const marker = movedMarker(
        move.origin,
        grip,
        move.delta + seconds,
        move.duration,
      );
      const delta =
        grip === "end"
          ? markerEnd(marker) - markerEnd(move.origin)
          : marker.start - move.origin.start;
      const next = { ...move, delta };
      held.current = next;
      setPreview(next);
    },
    [begin],
  );
  const quiet = markers.length === 0 && clippingFlags.length === 0;

  return (
    <div
      className={quiet ? "marker-lane empty" : "marker-lane"}
      style={{ width }}
    >
      {laneRow && (
        <MarkerLane
          markers={markers}
          authoritativeMarkers={authoritativeMarkers}
          start={0}
          pxPerSecond={zoomPxPerSec}
          width={width}
          duration={duration}
          selected={selected}
          readOnly={readOnly}
          anchorProps={LANE_ANCHOR}
          hitProps={hitProps}
          onSelect={onSelect}
          onDragStart={onDragStart}
          onDrag={onDrag}
          onDragEnd={finish}
          onNudge={onNudge}
          onNudgeEnd={finish}
          adding={addable ? adding : null}
          onAdd={addable ? onAdd : undefined}
          onAddCommit={addable ? onAddCommit : undefined}
          onAddCancel={addable ? onAddCancel : undefined}
        />
      )}
      {clippingFlags.length > 0 && (
        <div className="marker-row clipping" {...CLIPPING_ANCHOR}>
          {clippingFlags.map((flag) => {
            const note = flag.truncated ? "; later clipping not recorded" : "";
            return (
              <button
                key={flag.id}
                type="button"
                className="clipping-marker"
                style={{
                  left: flag.start * zoomPxPerSec,
                  width: Math.max(
                    MARKER_ROW_HEIGHT,
                    (flag.end - flag.start) * zoomPxPerSec,
                  ),
                }}
                aria-label={`Clipping on ${flag.label} at ${formatTimeShort(flag.start)}${note}`}
                title={`Clipping on ${flag.label}${note}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectClipping?.(flag);
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

type LiveProps = Omit<
  MarkerLaneHostProps,
  "readOnly" | "onMoveChapter" | "onMoveSocial" | "onAddChapter"
>;

export function LiveMarkerLane(props: LiveProps) {
  const { projectPath, projectEpoch, chapterAddPending, setSelection } = useDaw(
    (s) => ({
      projectPath: s.projectPath,
      projectEpoch: s.projectEpoch,
      chapterAddPending: s.chapterAddPending,
      setSelection: s.setSelection,
    }),
  );
  const onMoveChapter = useCallback(
    async (chapter: ChapterMarker, nextTime: number) => {
      await updateChapter(
        projectPath,
        chapter.time,
        chapter.title,
        nextTime,
        chapter.title,
      );
      if (useDawStore.getState().projectEpoch === projectEpoch) {
        setSelection({ kind: "chapter", id: chapter.title, time: nextTime });
      }
    },
    [projectPath, projectEpoch, setSelection],
  );
  const onMoveSocial = useCallback(
    async (id: string, start: number, end: number) => {
      await updateSocialClip(projectPath, id, start, end);
      if (useDawStore.getState().projectEpoch === projectEpoch)
        setSelection({ kind: "social", id });
    },
    [projectPath, projectEpoch, setSelection],
  );
  const onAddChapter = useCallback(async (atTime: number, title: string) => {
    await runAndAnnounceRefusal(() =>
      executePointerCommand("edit.addChapter", { atTime, title }),
    );
  }, []);
  return (
    <MarkerLaneHost
      key={`${projectEpoch}:${projectPath}`}
      {...props}
      readOnly={isShareProjectKey(projectPath)}
      onMoveChapter={onMoveChapter}
      onMoveSocial={onMoveSocial}
      onAddChapter={chapterAddPending ? undefined : onAddChapter}
    />
  );
}
