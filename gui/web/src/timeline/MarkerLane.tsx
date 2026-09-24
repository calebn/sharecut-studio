import { useRef } from "react";
import { updateChapter, updateSocialClip } from "../api";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { isShareProjectKey } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type {
  ChapterMarker,
  SocialClipView,
  TimelineComment,
} from "../types/project";
import { markerRows } from "./timelineMetrics";

interface MarkerLaneProps {
  chapters: ChapterMarker[];
  socialClips: SocialClipView[];
  comments: TimelineComment[];
  showMarkers: boolean;
  showComments: boolean;
  selectedCommentId?: string | null;
  zoomPxPerSec: number;
  width: number;
  onSelectChapter: (chapter: ChapterMarker) => void;
  onSelectSocial: (clip: SocialClipView) => void;
  onSelectComment: (comment: TimelineComment) => void;
}

export function MarkerLane({
  chapters,
  socialClips,
  comments,
  showMarkers,
  showComments,
  selectedCommentId = null,
  zoomPxPerSec,
  width,
  onSelectChapter,
  onSelectSocial,
  onSelectComment,
}: MarkerLaneProps) {
  const { projectPath, setSelection } = useDaw();
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

  const rows = markerRows({
    chapters,
    socialClips,
    comments,
    showMarkers,
    showComments,
  });

  if (!rows.chapters && !rows.social && !rows.comments) {
    return (
      <div
        className="marker-lane empty"
        style={{ width }}
        {...presenceAnchorProps(presenceAnchor("markers"))}
      />
    );
  }

  return (
    <div
      className="marker-lane"
      style={{ width }}
      {...presenceAnchorProps(presenceAnchor("markers"))}
    >
      {rows.chapters && (
        <>
          <div className="marker-row chapters">
            {chapters.map((ch) => (
              <button
                key={`${ch.time}-${ch.title}`}
                type="button"
                className="chapter-marker"
                style={{
                  left: ch.time * zoomPxPerSec - 12,
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
                    `${nextTime * zoomPxPerSec - 12}px`;
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
          <div className="marker-row social">
            {socialClips.map((clip) => {
              const left = clip.start * zoomPxPerSec;
              const w = Math.max(24, (clip.end - clip.start) * zoomPxPerSec);
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
                    el.style.width = `${Math.max(24, (end - start) * zoomPxPerSec)}px`;
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
                    if (Math.abs(dx) < 0.02) {
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
        <div className="marker-row comments">
          {comments.map((c) => {
            const left = c.timeline_start * zoomPxPerSec;
            const end = c.timeline_end ?? c.timeline_start;
            const isSpan =
              c.timeline_end != null && c.timeline_end > c.timeline_start;
            const w = isSpan
              ? Math.max(24, (end - c.timeline_start) * zoomPxPerSec)
              : 24;
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
                style={{ left: isSpan ? left : left - 12, width: w }}
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
    </div>
  );
}
