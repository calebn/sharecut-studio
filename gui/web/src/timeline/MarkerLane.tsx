import { useRef } from "react";
import { updateChapter, updateSocialClip } from "../api";
import { HANDLE_DRAG_MIN_PX } from "../edit/dragThreshold";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { isShareProjectKey } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type {
  ChapterMarker,
  SocialClipView,
  TimelineComment,
} from "../types/project";
import { MARKER_ROW_HEIGHT } from "../utils/layout";
import { formatTimeShort } from "../utils/time";
import type { ClippingFlag } from "./clippingFlags";
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

interface MarkerLaneProps {
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
}

export function MarkerLane({
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
}: MarkerLaneProps) {
  const { projectPath, setSelection } = useDaw((s) => ({
    projectPath: s.projectPath,
    setSelection: s.setSelection,
  }));
  const editable = !isShareProjectKey(projectPath);
  const chapterDrag = useRef<{
    time: number;
    title: string;
    startX: number;
    originTime: number;
  } | null>(null);
  const socialDrag = useRef<{
    id: string;
    mode: "move" | "start" | "end";
    startX: number;
    originStart: number;
    originEnd: number;
  } | null>(null);

  if (!rows.chapters && !rows.social && !rows.comments && !rows.clipping) {
    return (
      <div
        className="marker-lane empty"
        style={{ width }}
        {...presenceAnchorProps(presenceAnchor("markers"))}
      />
    );
  }

  return (
    <div className="marker-lane" style={{ width }}>
      {rows.chapters && (
        <>
          <div className="marker-row chapters" {...rowAnchor("chapters")}>
            {chapters.map((ch) => (
              <button
                key={`${ch.time}-${ch.title}`}
                type="button"
                className="chapter-marker"
                style={{
                  left: ch.time * zoomPxPerSec - MARKER_HALF,
                  cursor: editable ? "ew-resize" : "pointer",
                }}
                aria-label={`Chapter ${ch.title}`}
                title={ch.title}
                onClick={() => onSelectChapter(ch)}
                onPointerDown={(e) => {
                  if (!editable) {
                    return;
                  }
                  e.stopPropagation();
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                  chapterDrag.current = {
                    time: ch.time,
                    title: ch.title,
                    startX: e.clientX,
                    originTime: ch.time,
                  };
                }}
                onPointerMove={(e) => {
                  if (!chapterDrag.current) {
                    return;
                  }
                  const dx = e.clientX - chapterDrag.current.startX;
                  const nextTime = Math.max(
                    0,
                    chapterDrag.current.originTime + dx / zoomPxPerSec,
                  );
                  (e.currentTarget as HTMLElement).style.left =
                    `${nextTime * zoomPxPerSec - MARKER_HALF}px`;
                }}
                onPointerUp={(e) => {
                  if (!chapterDrag.current) {
                    return;
                  }
                  const dx = e.clientX - chapterDrag.current.startX;
                  const { time, title, originTime } = chapterDrag.current;
                  chapterDrag.current = null;
                  if (Math.abs(dx) < 3) {
                    return;
                  }
                  const nextTime = Math.max(0, originTime + dx / zoomPxPerSec);
                  void (async () => {
                    await updateChapter(
                      projectPath,
                      time,
                      title,
                      nextTime,
                      title,
                    );
                    setSelection({
                      kind: "chapter",
                      id: title,
                      time: nextTime,
                    });
                  })();
                }}
              />
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
                    if (!editable) {
                      return;
                    }
                    e.stopPropagation();
                    (e.target as Element).setPointerCapture?.(e.pointerId);
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
                      socialDrag.current.id !== clip.id
                    ) {
                      return;
                    }
                    const dx =
                      (e.clientX - socialDrag.current.startX) / zoomPxPerSec;
                    let start = socialDrag.current.originStart;
                    let end = socialDrag.current.originEnd;
                    if (socialDrag.current.mode === "move") {
                      const dur = end - start;
                      start = Math.max(0, start + dx);
                      end = start + dur;
                    } else if (socialDrag.current.mode === "start") {
                      start = Math.min(end - 0.05, Math.max(0, start + dx));
                    } else {
                      end = Math.max(start + 0.05, end + dx);
                    }
                    const el = e.currentTarget as HTMLElement;
                    el.style.left = `${start * zoomPxPerSec}px`;
                    el.style.width = `${Math.max(MARKER_ROW_HEIGHT, (end - start) * zoomPxPerSec)}px`;
                  }}
                  onPointerUp={(e) => {
                    if (
                      !socialDrag.current ||
                      socialDrag.current.id !== clip.id
                    ) {
                      return;
                    }
                    const dx =
                      (e.clientX - socialDrag.current.startX) / zoomPxPerSec;
                    const { mode, originStart, originEnd, id } =
                      socialDrag.current;
                    socialDrag.current = null;
                    if (Math.abs(dx) * zoomPxPerSec < HANDLE_DRAG_MIN_PX) {
                      return;
                    }
                    let start = originStart;
                    let end = originEnd;
                    if (mode === "move") {
                      const dur = end - start;
                      start = Math.max(0, start + dx);
                      end = start + dur;
                    } else if (mode === "start") {
                      start = Math.min(end - 0.05, Math.max(0, start + dx));
                    } else {
                      end = Math.max(start + 0.05, end + dx);
                    }
                    void (async () => {
                      await updateSocialClip(projectPath, id, start, end);
                    })();
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
