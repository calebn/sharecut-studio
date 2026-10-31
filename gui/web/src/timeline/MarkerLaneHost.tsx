import { useCallback, useMemo, useRef, useState } from "react";
import { addChapter, updateChapter, updateSocialClip } from "../api";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { isShareProjectKey } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { type MarkerGrip, MarkerLane } from "../system/MarkerLane";
import type {
  ChapterMarker,
  SocialClipView,
  TimelineComment,
} from "../types/project";
import { errorMessage } from "../utils/apiError";
import { MARKER_ROW_HEIGHT } from "../utils/layout";
import { formatTimeShort } from "../utils/time";
import type { ClippingFlag } from "./clippingFlags";
import { hitTargetProps } from "./hitTargets";
import { chapterMarkerId, laneMarkers, movedMarker } from "./laneMarkers";

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
  showMarkers: boolean;
  showComments: boolean;
  /** Ids of the selected markers, as `laneMarkers` names them. */
  selected: readonly string[];
  zoomPxPerSec: number;
  width: number;
  duration: number;
  /** False hides the system lane (a short touch screen with nothing marked), see `markerLaneRow`. */
  laneRow: boolean;
  /** A guest selects markers but cannot move them. */
  readOnly: boolean;
  /** A chapter moved: the chapter it started from, its new time. */
  onMoveChapter?: (
    chapter: ChapterMarker,
    nextTime: number,
  ) => void | Promise<void>;
  /** A social clip moved or resized: new bounds. */
  onMoveSocial?: (
    id: string,
    start: number,
    end: number,
  ) => void | Promise<void>;
  /** A chapter named on the lane (double-click on an empty part). Left out, the lane cannot add. */
  onAddChapter?: (seconds: number, title: string) => void | Promise<void>;
  clippingFlags?: readonly ClippingFlag[];
  onSelectChapter: (chapter: ChapterMarker) => void;
  onSelectSocial: (clip: SocialClipView) => void;
  onSelectComment: (comment: TimelineComment) => void;
  onSelectClipping?: (flag: ClippingFlag) => void;
}

/** The system marker lane over the project's chapters, social clips and comments, plus the clipping row. */
export function MarkerLaneHost({
  chapters,
  socialClips,
  comments,
  showMarkers,
  showComments,
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
  /** The held marker, drawn where the drag or the keys have put it until the project catches up. */
  const [preview, setPreview] = useState<{
    id: string;
    grip: MarkerGrip;
    delta: number;
  } | null>(null);
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
  const markers = useMemo(() => {
    const base = laneMarkers({
      chapters,
      socialClips,
      comments,
      showMarkers,
      showComments,
    });
    if (!preview) return base;
    return base.map((marker) =>
      marker.id === preview.id
        ? movedMarker(marker, preview.grip, preview.delta, duration)
        : marker,
    );
  }, [
    chapters,
    socialClips,
    comments,
    showMarkers,
    showComments,
    preview,
    duration,
  ]);
  const latest = useRef({ chapters, socialClips, comments });
  latest.current = { chapters, socialClips, comments };
  /** Seconds the held marker has moved: by pointer, or by the keys since the last release. */
  const moved = useRef(0);

  const onSelect = useCallback(
    (id: string) => {
      const { chapters, socialClips, comments } = latest.current;
      const chapter = chapters.find((c) => chapterMarkerId(c) === id);
      if (chapter) return onSelectChapter(chapter);
      const clip = socialClips.find((c) => c.id === id);
      if (clip) return onSelectSocial(clip);
      const comment = comments.find((c) => c.id === id);
      if (comment) onSelectComment(comment);
    },
    [onSelectChapter, onSelectSocial, onSelectComment],
  );

  /** Saves the move, then lets the preview go: the project now holds the new place (or the save failed and the marker returns). */
  const commit = useCallback(
    async (id: string, grip: MarkerGrip, delta: number) => {
      try {
        if (delta === 0) return;
        const { chapters, socialClips } = latest.current;
        const chapter = chapters.find((c) => chapterMarkerId(c) === id);
        if (chapter) {
          const next = movedMarker(
            { kind: "chapter", id, start: chapter.time, title: chapter.title },
            grip,
            delta,
            duration,
          ).start;
          if (next !== chapter.time) await onMoveChapter?.(chapter, next);
          return;
        }
        const clip = socialClips.find((c) => c.id === id);
        if (!clip) return;
        const moved = movedMarker(
          {
            kind: "clip",
            id,
            start: clip.start,
            end: clip.end,
            title: "",
          },
          grip,
          delta,
          duration,
        );
        if (
          moved.kind === "clip" &&
          (moved.start !== clip.start || moved.end !== clip.end)
        )
          await onMoveSocial?.(id, moved.start, moved.end);
      } finally {
        setPreview(null);
      }
    },
    [duration, onMoveChapter, onMoveSocial],
  );

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

  const onDragStart = useCallback(() => {
    moved.current = 0;
    return true;
  }, []);
  const onDrag = useCallback(
    (id: string, grip: MarkerGrip, drag: { delta: number }) => {
      moved.current = drag.delta;
      setPreview({ id, grip, delta: drag.delta });
    },
    [],
  );
  const onDragEnd = useCallback(
    (id: string, grip: MarkerGrip, committed: boolean) => {
      const delta = moved.current;
      moved.current = 0;
      if (committed) void commit(id, grip, delta);
      else setPreview(null);
    },
    [commit],
  );
  const onNudge = useCallback(
    (id: string, grip: MarkerGrip, seconds: number) => {
      moved.current += seconds;
      setPreview({ id, grip, delta: moved.current });
    },
    [],
  );
  const onNudgeEnd = useCallback(
    (id: string, grip: MarkerGrip) => {
      const delta = moved.current;
      moved.current = 0;
      void commit(id, grip, delta);
    },
    [commit],
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
          onDragEnd={onDragEnd}
          onNudge={onNudge}
          onNudgeEnd={onNudgeEnd}
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

/** Live wiring: host-only drags commit UpdateChapter / UpdateSocialClip. */
export function LiveMarkerLane(props: LiveProps) {
  const {
    projectPath,
    projectEpoch,
    setSelection,
    announceStatus,
    setLayerVisible,
  } = useDaw((s) => ({
    projectPath: s.projectPath,
    projectEpoch: s.projectEpoch,
    setSelection: s.setSelection,
    announceStatus: s.announceStatus,
    setLayerVisible: s.setLayerVisible,
  }));
  const onMoveChapter = useCallback(
    async (chapter: ChapterMarker, nextTime: number) => {
      await updateChapter(
        projectPath,
        chapter.time,
        chapter.title,
        nextTime,
        chapter.title,
      );
      setSelection({ kind: "chapter", id: chapter.title, time: nextTime });
    },
    [projectPath, setSelection],
  );
  const onMoveSocial = useCallback(
    async (id: string, start: number, end: number) => {
      await updateSocialClip(projectPath, id, start, end);
      setSelection({ kind: "social", id });
    },
    [projectPath, setSelection],
  );
  const onAddChapter = useCallback(
    async (at: number, title: string) => {
      setLayerVisible("showMarkers", true);
      try {
        const undo = await addChapter(projectPath, at, title);
        setSelection({ kind: "chapter", id: title, time: at });
        announceStatus(`Chapter added at ${at.toFixed(1)}s`, { undo });
      } catch (err) {
        announceStatus(`Add chapter failed: ${errorMessage(err)}`, {
          tone: "error",
        });
      }
    },
    [projectPath, setSelection, announceStatus, setLayerVisible],
  );
  return (
    <MarkerLaneHost
      key={`${projectEpoch}:${projectPath}`}
      {...props}
      readOnly={isShareProjectKey(projectPath)}
      onMoveChapter={onMoveChapter}
      onMoveSocial={onMoveSocial}
      onAddChapter={onAddChapter}
    />
  );
}
