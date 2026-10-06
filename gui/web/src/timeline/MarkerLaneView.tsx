import type { CSSProperties } from "react";
import { useCallback, useLayoutEffect, useRef } from "react";
import { isHandleDrag } from "../edit/dragThreshold";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import type {
  ChapterMarker,
  SocialClipView,
  TimelineComment,
} from "../types/project";
import { MARKER_ROW_HEIGHT } from "../utils/layout";
import { formatTimeShort } from "../utils/time";
import { chapterLabelRoomPx } from "./chapterLabels";
import type { ClippingFlag } from "./clippingFlags";
import { hitTargetProps } from "./hitTargets";
import { type SocialDragMode, socialSpanAfterDrag } from "./socialDrag";
import type { MarkerRows } from "./timelineMetrics";

/** Point markers are row-square; center them on their time. */
const MARKER_HALF = MARKER_ROW_HEIGHT / 2;
const NO_FLAGS: readonly ClippingFlag[] = [];

/**
 * One presence anchor per row: rows collapse with each viewer's layer
 * toggles, so a lane-wide Y fraction would put a remote cursor on another row.
 */
function rowAnchor(row: keyof MarkerRows): Record<string, string> {
  return presenceAnchorProps(presenceAnchor("markers", row));
}

export interface MarkerLaneViewProps {
  chapters: readonly ChapterMarker[];
  socialClips: readonly SocialClipView[];
  comments: readonly TimelineComment[];
  /** Rows to draw, from `markerRows` (TimelineView sizes the lane from them). */
  rows: MarkerRows;
  selectedCommentId?: string | null;
  zoomPxPerSec: number;
  width: number;
  onSelectChapter: (chapter: ChapterMarker) => void;
  onSelectSocial: (clip: SocialClipView) => void;
  onSelectComment: (comment: TimelineComment) => void;
  /** Recording clip flags, one per region per track. */
  clippingFlags?: readonly ClippingFlag[];
  onSelectClipping?: (flag: ClippingFlag) => void;
  /** Host-editable project: chapter and social markers drag. */
  editable: boolean;
  /** Chapter drag release past 3 px: the chapter it started from, new time. */
  onMoveChapter?: (chapter: ChapterMarker, nextTime: number) => void;
  /** Social drag release past the drag threshold: new bounds. */
  onMoveSocial?: (id: string, start: number, end: number) => void;
}

export function MarkerLaneView({
  chapters,
  socialClips,
  comments,
  rows,
  selectedCommentId = null,
  zoomPxPerSec,
  width,
  onSelectChapter,
  onSelectSocial,
  onSelectComment,
  clippingFlags = NO_FLAGS,
  onSelectClipping,
  editable,
  onMoveChapter,
  onMoveSocial,
}: MarkerLaneViewProps) {
  const chapterDrag = useRef<{
    pointerId: number;
    zoom: number;
    target: HTMLButtonElement;
    originLeft: string;
    paintedLeft: string | null;
    time: number;
    title: string;
    startX: number;
    originTime: number;
  } | null>(null);
  const socialDrag = useRef<{
    pointerId: number;
    zoom: number;
    target: HTMLButtonElement;
    originLeft: string;
    originWidth: string;
    paintedLeft: string | null;
    paintedWidth: string | null;
    id: string;
    mode: SocialDragMode;
    startX: number;
    originStart: number;
    originEnd: number;
  } | null>(null);

  const latest = useRef({ chapters, socialClips });
  latest.current = { chapters, socialClips };
  const finishChapter = useCallback((cancel: boolean) => {
    const drag = chapterDrag.current;
    if (!drag) return;
    chapterDrag.current = null;
    if (
      cancel &&
      drag.target.style.left === drag.paintedLeft &&
      latest.current.chapters.some(
        (ch) => ch.time === drag.time && ch.title === drag.title,
      )
    )
      drag.target.style.left = drag.originLeft;
    if (drag.target.hasPointerCapture?.(drag.pointerId))
      drag.target.releasePointerCapture(drag.pointerId);
  }, []);
  const finishSocial = useCallback((cancel: boolean) => {
    const drag = socialDrag.current;
    if (!drag) return;
    socialDrag.current = null;
    if (
      cancel &&
      drag.target.style.left === drag.paintedLeft &&
      drag.target.style.width === drag.paintedWidth &&
      latest.current.socialClips.some(
        (clip) =>
          clip.id === drag.id &&
          clip.start === drag.originStart &&
          clip.end === drag.originEnd,
      )
    ) {
      drag.target.style.left = drag.originLeft;
      drag.target.style.width = drag.originWidth;
    }
    if (drag.target.hasPointerCapture?.(drag.pointerId))
      drag.target.releasePointerCapture(drag.pointerId);
  }, []);
  useLayoutEffect(
    () => () => {
      finishChapter(true);
      finishSocial(true);
    },
    [finishChapter, finishSocial],
  );

  useLayoutEffect(() => {
    const chapter = chapterDrag.current;
    if (
      chapter &&
      (!editable ||
        !rows.chapters ||
        chapter.zoom !== zoomPxPerSec ||
        !chapters.some(
          (ch) => ch.time === chapter.time && ch.title === chapter.title,
        ))
    )
      finishChapter(true);
    const social = socialDrag.current;
    if (
      social &&
      (!editable ||
        !rows.social ||
        social.zoom !== zoomPxPerSec ||
        !socialClips.some(
          (clip) =>
            clip.id === social.id &&
            clip.start === social.originStart &&
            clip.end === social.originEnd,
        ))
    )
      finishSocial(true);
  });

  if (!rows.chapters && !rows.social && !rows.comments && !rows.clipping) {
    return (
      <div
        className="marker-lane empty"
        style={{ width }}
        {...presenceAnchorProps(presenceAnchor("markers"))}
      />
    );
  }

  const labelRoom = chapterLabelRoomPx(chapters, zoomPxPerSec, width);

  return (
    <div className="marker-lane" style={{ width }}>
      {rows.chapters && (
        <>
          <div className="marker-row chapters" {...rowAnchor("chapters")}>
            {chapters.map((ch, i) => (
              <button
                key={`${ch.time}-${ch.title}`}
                type="button"
                className="chapter-marker"
                {...hitTargetProps(
                  "chapter",
                  `${ch.time}-${ch.title}`,
                  ch.time,
                )}
                style={
                  {
                    left: ch.time * zoomPxPerSec - MARKER_HALF,
                    cursor: editable ? "ew-resize" : "pointer",
                    ...(labelRoom[i] != null
                      ? { "--chapter-label-room": `${labelRoom[i]}px` }
                      : {}),
                  } as CSSProperties
                }
                aria-label={`Chapter ${ch.title}`}
                title={ch.title}
                onClick={() => onSelectChapter(ch)}
                onPointerDown={(e) => {
                  if (
                    !editable ||
                    chapterDrag.current ||
                    socialDrag.current ||
                    (e.pointerType === "mouse" && e.button !== 0)
                  ) {
                    return;
                  }
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                  chapterDrag.current = {
                    pointerId: e.pointerId,
                    zoom: zoomPxPerSec,
                    target: e.currentTarget,
                    originLeft: e.currentTarget.style.left,
                    paintedLeft: null,
                    time: ch.time,
                    title: ch.title,
                    startX: e.clientX,
                    originTime: ch.time,
                  };
                }}
                onPointerMove={(e) => {
                  if (
                    !chapterDrag.current ||
                    chapterDrag.current.pointerId !== e.pointerId ||
                    chapterDrag.current.target !== e.currentTarget
                  ) {
                    return;
                  }
                  const dx = e.clientX - chapterDrag.current.startX;
                  const nextTime = Math.max(
                    0,
                    chapterDrag.current.originTime + dx / zoomPxPerSec,
                  );
                  const left = `${nextTime * zoomPxPerSec - MARKER_HALF}px`;
                  chapterDrag.current.target.style.left = left;
                  chapterDrag.current.paintedLeft =
                    chapterDrag.current.target.style.left;
                }}
                onPointerUp={(e) => {
                  if (
                    !chapterDrag.current ||
                    chapterDrag.current.pointerId !== e.pointerId ||
                    chapterDrag.current.target !== e.currentTarget
                  ) {
                    return;
                  }
                  const dx = e.clientX - chapterDrag.current.startX;
                  const { time, title, originTime } = chapterDrag.current;
                  if (Math.abs(dx) < 3) {
                    finishChapter(true);
                    return;
                  }
                  const nextTime = Math.max(0, originTime + dx / zoomPxPerSec);
                  finishChapter(nextTime === originTime);
                  if (nextTime !== originTime)
                    onMoveChapter?.({ time, title }, nextTime);
                }}
                onPointerCancel={(e) => {
                  if (
                    chapterDrag.current?.pointerId === e.pointerId &&
                    chapterDrag.current.target === e.currentTarget
                  )
                    finishChapter(true);
                }}
                onLostPointerCapture={(e) => {
                  if (
                    chapterDrag.current?.pointerId === e.pointerId &&
                    chapterDrag.current.target === e.currentTarget
                  )
                    finishChapter(true);
                }}
                onBlur={(e) => {
                  if (chapterDrag.current?.target === e.currentTarget)
                    finishChapter(true);
                }}
                onKeyDown={(e) => {
                  if (
                    !chapterDrag.current ||
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
                    ].includes(e.key)
                  )
                    return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.key === "Escape") finishChapter(true);
                }}
              >
                {labelRoom[i] != null ? (
                  <span className="chapter-marker-label" aria-hidden="true">
                    {ch.title}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </>
      )}
      {rows.social && (
        <>
          <div className="marker-row social" {...rowAnchor("social")}>
            {socialClips.map((clip) => {
              const left = clip.start * zoomPxPerSec;
              const w = Math.max(
                MARKER_ROW_HEIGHT,
                (clip.end - clip.start) * zoomPxPerSec,
              );
              return (
                <button
                  key={clip.id}
                  type="button"
                  className={`social-marker${clip.approved ? " approved" : ""}`}
                  style={{
                    left,
                    width: w,
                    cursor: editable ? "grab" : "pointer",
                  }}
                  aria-label={clip.title_suggestion ?? `Social clip ${clip.id}`}
                  title={
                    clip.title_suggestion ??
                    `Social ${clip.id} (${clip.score.toFixed(2)})`
                  }
                  onClick={() => onSelectSocial(clip)}
                  onPointerDown={(e) => {
                    if (
                      !editable ||
                      chapterDrag.current ||
                      socialDrag.current ||
                      (e.pointerType === "mouse" && e.button !== 0)
                    ) {
                      return;
                    }
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture?.(e.pointerId);
                    const el = e.currentTarget as HTMLElement;
                    const rect = el.getBoundingClientRect();
                    const localX = e.clientX - rect.left;
                    const edge = 6;
                    const mode =
                      localX <= edge
                        ? "start"
                        : localX >= rect.width - edge
                          ? "end"
                          : "move";
                    socialDrag.current = {
                      pointerId: e.pointerId,
                      zoom: zoomPxPerSec,
                      target: e.currentTarget,
                      originLeft: el.style.left,
                      originWidth: el.style.width,
                      paintedLeft: null,
                      paintedWidth: null,
                      id: clip.id,
                      mode,
                      startX: e.clientX,
                      originStart: clip.start,
                      originEnd: clip.end,
                    };
                  }}
                  onPointerMove={(e) => {
                    if (
                      !socialDrag.current ||
                      socialDrag.current.id !== clip.id ||
                      socialDrag.current.pointerId !== e.pointerId ||
                      socialDrag.current.target !== e.currentTarget
                    ) {
                      return;
                    }
                    const dx =
                      (e.clientX - socialDrag.current.startX) / zoomPxPerSec;
                    const { start, end } = socialSpanAfterDrag(
                      socialDrag.current.mode,
                      socialDrag.current.originStart,
                      socialDrag.current.originEnd,
                      dx,
                    );
                    const el = e.currentTarget as HTMLElement;
                    el.style.left = `${start * zoomPxPerSec}px`;
                    el.style.width = `${Math.max(MARKER_ROW_HEIGHT, (end - start) * zoomPxPerSec)}px`;
                    socialDrag.current.paintedLeft = el.style.left;
                    socialDrag.current.paintedWidth = el.style.width;
                  }}
                  onPointerUp={(e) => {
                    if (
                      !socialDrag.current ||
                      socialDrag.current.id !== clip.id ||
                      socialDrag.current.pointerId !== e.pointerId ||
                      socialDrag.current.target !== e.currentTarget
                    ) {
                      return;
                    }
                    const { mode, originStart, originEnd, id, startX } =
                      socialDrag.current;
                    if (!isHandleDrag(startX, e.clientX)) {
                      finishSocial(true);
                      return;
                    }
                    const dx = (e.clientX - startX) / zoomPxPerSec;
                    const { start, end } = socialSpanAfterDrag(
                      mode,
                      originStart,
                      originEnd,
                      dx,
                    );
                    finishSocial(start === originStart && end === originEnd);
                    if (start !== originStart || end !== originEnd)
                      onMoveSocial?.(id, start, end);
                  }}
                  onPointerCancel={(e) => {
                    if (
                      socialDrag.current?.pointerId === e.pointerId &&
                      socialDrag.current.target === e.currentTarget
                    )
                      finishSocial(true);
                  }}
                  onLostPointerCapture={(e) => {
                    if (
                      socialDrag.current?.pointerId === e.pointerId &&
                      socialDrag.current.target === e.currentTarget
                    )
                      finishSocial(true);
                  }}
                  onBlur={(e) => {
                    if (socialDrag.current?.target === e.currentTarget)
                      finishSocial(true);
                  }}
                  onKeyDown={(e) => {
                    if (
                      !socialDrag.current ||
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
                      ].includes(e.key)
                    )
                      return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.key === "Escape") finishSocial(true);
                  }}
                />
              );
            })}
          </div>
        </>
      )}
      {rows.comments && (
        <div className="marker-row comments" {...rowAnchor("comments")}>
          {comments.map((c) => {
            const left = c.timeline_start * zoomPxPerSec;
            const end = c.timeline_end ?? c.timeline_start;
            const isSpan =
              c.timeline_end != null && c.timeline_end > c.timeline_start;
            const w = isSpan
              ? Math.max(
                  MARKER_ROW_HEIGHT,
                  (end - c.timeline_start) * zoomPxPerSec,
                )
              : MARKER_ROW_HEIGHT;
            const openActions = c.action_items.filter((a) => !a.done).length;
            const title = [
              c.author,
              c.body.slice(0, 80),
              openActions ? `${openActions} open action(s)` : null,
              c.resolved ? "resolved" : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <button
                key={c.id}
                type="button"
                className={`comment-marker${isSpan ? " span" : " pin"}${
                  c.resolved ? " resolved" : ""
                }${selectedCommentId === c.id ? " selected" : ""}`}
                style={{ left: isSpan ? left : left - MARKER_HALF, width: w }}
                aria-label={`Comment by ${c.author}`}
                aria-pressed={selectedCommentId === c.id}
                title={title}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectComment(c);
                }}
              />
            );
          })}
        </div>
      )}
      {rows.clipping && (
        <div className="marker-row clipping" {...rowAnchor("clipping")}>
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
