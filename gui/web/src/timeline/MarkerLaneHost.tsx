import { useCallback, useMemo, useRef } from "react";
import { updateChapter, updateSocialClip } from "../api";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { isShareProjectKey } from "../shareMode";
import { useDaw } from "../state/useDaw";
import {
  MARKER_MIN_SPAN,
  type MarkerGrip,
  MarkerLane,
} from "../system/MarkerLane";
import type {
  ChapterMarker,
  SocialClipView,
  TimelineComment,
} from "../types/project";
import { MARKER_ROW_HEIGHT } from "../utils/layout";
import { formatTimeShort } from "../utils/time";
import type { ClippingFlag } from "./clippingFlags";
import { hitTargetProps } from "./hitTargets";
import { chapterMarkerId, laneMarkers } from "./laneMarkers";
import { socialSpanAfterDrag } from "./socialDrag";

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
  touch?: boolean;
  /** A guest selects markers but cannot move them. */
  readOnly: boolean;
  /** A chapter moved: the chapter it started from, its new time. */
  onMoveChapter?: (chapter: ChapterMarker, nextTime: number) => void;
  /** A social clip moved or resized: new bounds. */
  onMoveSocial?: (id: string, start: number, end: number) => void;
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
  touch,
  readOnly,
  onMoveChapter,
  onMoveSocial,
  clippingFlags = NO_FLAGS,
  onSelectChapter,
  onSelectSocial,
  onSelectComment,
  onSelectClipping,
}: MarkerLaneHostProps) {
  const markers = useMemo(
    () =>
      laneMarkers({
        chapters,
        socialClips,
        comments,
        showMarkers,
        showComments,
      }),
    [chapters, socialClips, comments, showMarkers, showComments],
  );
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

  const commit = useCallback(
    (id: string, grip: MarkerGrip, delta: number) => {
      if (delta === 0) return;
      const { chapters, socialClips } = latest.current;
      const chapter = chapters.find((c) => chapterMarkerId(c) === id);
      if (chapter) {
        const next = Math.max(0, Math.min(duration, chapter.time + delta));
        if (next === chapter.time) return;
        onMoveChapter?.(chapter, next);
        return;
      }
      const clip = socialClips.find((c) => c.id === id);
      if (!clip) return;
      const span = socialSpanAfterDrag(grip, clip.start, clip.end, delta);
      const start = Math.max(0, span.start);
      const end = Math.min(
        duration,
        Math.max(span.end, start + MARKER_MIN_SPAN),
      );
      if (start === clip.start && end === clip.end) return;
      onMoveSocial?.(id, start, end);
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

  const quiet = markers.length === 0 && clippingFlags.length === 0;

  return (
    <div
      className={quiet ? "marker-lane empty" : "marker-lane"}
      style={{ width }}
    >
      <MarkerLane
        markers={markers}
        start={0}
        pxPerSecond={zoomPxPerSec}
        width={width}
        duration={duration}
        selected={selected}
        readOnly={readOnly}
        touch={touch}
        anchorProps={LANE_ANCHOR}
        hitProps={hitProps}
        onSelect={onSelect}
        onDragStart={() => {
          moved.current = 0;
          return true;
        }}
        onDrag={(_id, _grip, drag) => {
          moved.current = drag.delta;
        }}
        onDragEnd={(id, grip, committed) => {
          const delta = moved.current;
          moved.current = 0;
          if (committed) commit(id, grip, delta);
        }}
        onNudge={(_id, _grip, seconds) => {
          moved.current += seconds;
        }}
        onNudgeEnd={(id, grip) => {
          const delta = moved.current;
          moved.current = 0;
          commit(id, grip, delta);
        }}
      />
      {clippingFlags.length > 0 && (
        <div
          className="marker-row clipping"
          style={{ position: "relative", height: MARKER_ROW_HEIGHT }}
          {...CLIPPING_ANCHOR}
        >
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
  "readOnly" | "onMoveChapter" | "onMoveSocial"
>;

/** Live wiring: host-only drags commit UpdateChapter / UpdateSocialClip. */
export function LiveMarkerLane(props: LiveProps) {
  const { projectPath, projectEpoch, setSelection } = useDaw((s) => ({
    projectPath: s.projectPath,
    projectEpoch: s.projectEpoch,
    setSelection: s.setSelection,
  }));
  const onMoveChapter = useCallback(
    (chapter: ChapterMarker, nextTime: number) => {
      void (async () => {
        await updateChapter(
          projectPath,
          chapter.time,
          chapter.title,
          nextTime,
          chapter.title,
        );
        setSelection({ kind: "chapter", id: chapter.title, time: nextTime });
      })();
    },
    [projectPath, setSelection],
  );
  const onMoveSocial = useCallback(
    (id: string, start: number, end: number) => {
      void (async () => {
        await updateSocialClip(projectPath, id, start, end);
        setSelection({ kind: "social", id });
      })();
    },
    [projectPath, setSelection],
  );
  return (
    <MarkerLaneHost
      key={`${projectEpoch}:${projectPath}`}
      {...props}
      readOnly={isShareProjectKey(projectPath)}
      onMoveChapter={onMoveChapter}
      onMoveSocial={onMoveSocial}
    />
  );
}
