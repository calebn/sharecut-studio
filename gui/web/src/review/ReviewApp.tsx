import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { registerReviewWebMcpTools } from "../agentic/webmcp";
import { addCommentReply, createComment, setCommentActionDone } from "../api";
import { CommentCard, CommentCompose } from "../comments";
import { useGuestProgress } from "../hooks/useGuestProgress";
import { PipelineStatusChip } from "../layout/PipelineStatusChip";
import { hasShareCapability, shareProjectKey } from "../shareMode";
import type { TimelineComment } from "../types/project";
import { ErrorScreen, InlineError, LoadingScreen } from "../ui";
import { errorMessage, readApiError } from "../utils/apiError";
import {
  loadCommentAuthor,
  resolveCommentActor,
  saveCommentAuthor,
} from "../utils/commentAuthor";
import {
  pipelineKindLabel,
  pipelineStatusLabel,
} from "../utils/pipelineProgress";
import { formatTimeShort } from "../utils/time";
import "../styles/partials/review-entry.css";

interface ReviewProject {
  mode: string;
  guest_mode?: string;
  token: string;
  meta: { name: string };
  timeline_duration_sec: number;
  review_version: { id: string; label: string };
  comments: TimelineComment[];
  capabilities: string[];
}

async function loadReview(token: string): Promise<ReviewProject> {
  const res = await fetch(`/api/review/${encodeURIComponent(token)}/project`);
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<ReviewProject>;
}

export function ReviewApp({ token }: { token: string }) {
  const progressJob = useGuestProgress(token);
  const [project, setProject] = useState<ReviewProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [author, setAuthor] = useState(loadCommentAuthor);
  const [body, setBody] = useState("");
  const [startSec, setStartSec] = useState(0);
  const [busy, setBusy] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const inflightRef = useRef(false);
  const projectKey = shareProjectKey(token);

  const audioUrl = useMemo(
    () => `/api/review/${encodeURIComponent(token)}/audio`,
    [token],
  );

  const beginInflight = (): boolean => {
    if (inflightRef.current) {
      return false;
    }
    inflightRef.current = true;
    setBusy(true);
    setError(null);
    return true;
  };

  const endInflight = () => {
    inflightRef.current = false;
    setBusy(false);
  };

  const refresh = useCallback(async () => {
    setProject(await loadReview(token));
  }, [token]);

  useEffect(() => {
    loadReview(token)
      .then(setProject)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [token]);

  useEffect(() => {
    if (!project?.meta?.name) {
      return;
    }
    const previous = document.title;
    document.title = project.meta.name;
    return () => {
      document.title = previous;
    };
  }, [project?.meta?.name]);

  useEffect(() => {
    if (!project) {
      return;
    }
    const caps = project.capabilities ?? [];
    return registerReviewWebMcpTools({
      playPause: () => {
        const el = audioRef.current;
        if (!el) {
          return;
        }
        if (el.paused) {
          void el.play();
        } else {
          el.pause();
        }
      },
      seek: (seconds) => {
        if (audioRef.current) {
          audioRef.current.currentTime = Math.max(0, seconds);
          setStartSec(audioRef.current.currentTime);
        }
      },
      canComment: hasShareCapability(caps, "comment"),
      addComment: async (bodyText) => {
        const who = resolveCommentActor(loadCommentAuthor());
        await createComment(projectKey, {
          body: bodyText,
          author: who,
          timelineStart: audioRef.current?.currentTime ?? 0,
        });
        await refresh();
      },
    });
  }, [project, projectKey, refresh]);

  const onPost = async () => {
    const who = resolveCommentActor(author);
    setAuthor(who);
    saveCommentAuthor(who);
    if (!body.trim()) {
      setError("Comment body is required");
      return;
    }
    if (!beginInflight()) {
      return;
    }
    try {
      await createComment(projectKey, {
        body: body.trim(),
        author: who,
        timelineStart: startSec,
        timelineEnd: null,
      });
      setBody("");
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      endInflight();
    }
  };

  if (error && !project) {
    return <ErrorScreen message={error} />;
  }
  if (!project) {
    return <LoadingScreen label="Loading review…" />;
  }

  const caps = project.capabilities ?? [];
  const canPlay = hasShareCapability(caps, "play");
  const canComment = hasShareCapability(caps, "comment");
  const canReply = hasShareCapability(caps, "reply");
  const canAction = hasShareCapability(caps, "action");
  const modeLabel = project.guest_mode ?? "comment";

  const onReply = async (commentId: string, text: string) => {
    const who = resolveCommentActor(author);
    setAuthor(who);
    saveCommentAuthor(who);
    if (!text.trim()) {
      setError("Reply body is required");
      return;
    }
    if (!beginInflight()) {
      return;
    }
    try {
      await addCommentReply(projectKey, commentId, {
        body: text.trim(),
        author: who,
      });
      setReplyDrafts((prev) => ({ ...prev, [commentId]: "" }));
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      endInflight();
    }
  };

  const onToggleAction = async (
    commentId: string,
    actionId: string,
    done: boolean,
  ) => {
    if (!beginInflight()) {
      return;
    }
    const who = resolveCommentActor(author);
    setAuthor(who);
    saveCommentAuthor(who);
    try {
      await setCommentActionDone(projectKey, commentId, actionId, {
        done,
        by: who,
      });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      endInflight();
    }
  };

  return (
    <main className="cover review-shell">
      <div className="cover-center center stack">
        <header className="stack">
          <h1 className="wordmark">{project.meta.name}</h1>
          <p className="lede">
            Review mix: {project.review_version.label} ·{" "}
            {formatTimeShort(project.timeline_duration_sec)} · mode {modeLabel}
          </p>
          {progressJob ? (
            <>
              <div
                className="sr-only"
                role="status"
                aria-live="polite"
                aria-atomic="true"
                aria-busy={progressJob.status === "running" ? true : undefined}
              >
                {`${pipelineKindLabel(progressJob.kind)}: ${pipelineStatusLabel(progressJob.status)}${
                  progressJob.message ? `: ${progressJob.message}` : ""
                }`}
              </div>
              <PipelineStatusChip job={progressJob} />
            </>
          ) : null}
        </header>
        {canPlay ? (
          <audio
            ref={audioRef}
            controls
            src={audioUrl}
            className="review-audio"
            onTimeUpdate={() => {
              if (audioRef.current) {
                setStartSec(audioRef.current.currentTime);
              }
            }}
          >
            <track
              kind="captions"
              src="data:text/vtt,WEBVTT"
              label="Timed review comments provide feedback as an alternative to captions"
              srcLang="en"
            />
          </audio>
        ) : (
          <p className="review-playhead">
            Playback not enabled for this share.
          </p>
        )}
        {canComment && (
          <>
            <p className="review-playhead">
              Comment at playhead: {formatTimeShort(startSec)}
            </p>
            <CommentCompose
              className="review-compose box elevated"
              author={author}
              onAuthorChange={setAuthor}
              body={body}
              onBodyChange={setBody}
              busy={busy}
              onSubmit={() => void onPost()}
              bodyPlaceholder="Leave feedback…"
            />
          </>
        )}
        <InlineError message={error} />
        <ul className="comments-list review-comments">
          {project.comments.map((c) => (
            <CommentCard
              key={c.id}
              comment={c}
              showResolve={false}
              showReply={canReply}
              busy={busy}
              replyDraft={replyDrafts[c.id] ?? ""}
              onReplyDraftChange={
                canReply
                  ? (value) =>
                      setReplyDrafts((prev) => ({ ...prev, [c.id]: value }))
                  : undefined
              }
              onReply={
                canReply
                  ? () => void onReply(c.id, replyDrafts[c.id] ?? "")
                  : undefined
              }
              onToggleAction={
                canAction
                  ? (actionId, done) =>
                      void onToggleAction(c.id, actionId, done)
                  : undefined
              }
            />
          ))}
          {project.comments.length === 0 && (
            <li className="comments-empty">No comments yet.</li>
          )}
        </ul>
      </div>
    </main>
  );
}
