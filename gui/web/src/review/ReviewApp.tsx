import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { registerReviewWebMcpTools } from "../agentic/webmcp";
import { addCommentReply, createComment, setCommentActionDone } from "../api";
import { CommentCard, CommentCompose } from "../comments";
import { useGuestProgress } from "../hooks/useGuestProgress";
import { PipelineStatusChip } from "../layout/PipelineStatusChip";
import { hasShareCapability, shareProjectKey } from "../shareMode";
import type { TimelineComment } from "../types/project";
import { EmptyState, ErrorScreen, InlineError, LoadingScreen } from "../ui";
import { errorMessage, readApiError } from "../utils/apiError";
import { commitCommentActor, sessionDisplayName } from "../utils/commentAuthor";
import {
  pipelineKindLabel,
  pipelineStatusLabel,
} from "../utils/pipelineProgress";
import { formatTimeShort } from "../utils/time";
import "../styles/partials/review-entry.css";

const EMPTY_COMMENTS: TimelineComment[] = [];

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

async function loadReview(
  token: string,
  signal: AbortSignal,
): Promise<ReviewProject> {
  const res = await fetch(`/api/review/${encodeURIComponent(token)}/project`, {
    signal,
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<ReviewProject>;
}

export function ReviewApp({ token }: { token: string }) {
  const connection = useGuestProgress(token);
  const progressJob = connection.job;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const [projectState, setProject] = useState<{
    scope: typeof connection.scope;
    project: ReviewProject;
    revision: string | null;
  } | null>(null);
  const project =
    projectState?.scope === connection.scope ? projectState.project : null;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [author, setAuthor] = useState(() => sessionDisplayName("guest"));
  const [body, setBody] = useState("");
  const [startSec, setStartSec] = useState(0);
  const [busyScope, setBusy] = useState<typeof connection.scope | null>(null);
  const busy = busyScope === connection.scope;
  const [openOnly, setOpenOnly] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const inflightRef = useRef<typeof connection.scope | null>(null);
  const activeRefreshRef = useRef<AbortController | null>(null);
  const projectKey = shareProjectKey(token);

  const audioUrl = useMemo(
    () => `/api/review/${encodeURIComponent(token)}/audio`,
    [token],
  );
  const selectedComments =
    connection.healthy || connection.revision !== projectState?.revision
      ? (connection.basisComments ?? project?.comments ?? EMPTY_COMMENTS)
      : (project?.comments ?? EMPTY_COMMENTS);
  const visibleComments = useMemo(() => {
    if (!project) return [];
    return openOnly
      ? selectedComments.filter((comment) => !comment.resolved)
      : selectedComments;
  }, [openOnly, project, selectedComments]);

  const beginInflight = (): boolean => {
    if (inflightRef.current === connection.scope) {
      return false;
    }
    inflightRef.current = connection.scope;
    setBusy(connection.scope);
    setError(null);
    return true;
  };

  const endInflight = () => {
    inflightRef.current = null;
    setBusy(null);
  };

  const refresh = useCallback(
    async (skipIfPending = false) => {
      if (skipIfPending && activeRefreshRef.current) return;
      activeRefreshRef.current?.abort();
      const controller = new AbortController();
      const scope = connectionRef.current.scope;
      const revision = connectionRef.current.revision;
      activeRefreshRef.current = controller;
      try {
        const next = await loadReview(token, controller.signal);
        if (
          !controller.signal.aborted &&
          connectionRef.current.scope === scope
        ) {
          const current = connectionRef.current;
          const comments =
            current.revision !== revision && current.basisComments
              ? current.basisComments
              : next.comments;
          setProject({
            scope,
            project: { ...next, comments },
            revision: current.revision,
          });
          setLoadError(null);
        }
      } catch (cause) {
        if (!controller.signal.aborted && connectionRef.current.scope === scope)
          throw cause;
      } finally {
        if (activeRefreshRef.current === controller) {
          activeRefreshRef.current = null;
        }
      }
    },
    [token],
  );

  useEffect(() => {
    let active = true;
    setBody("");
    setReplyDrafts({});
    setError(null);
    setLoadError(null);
    void refresh().catch((e: unknown) => {
      if (active) setLoadError(errorMessage(e));
    });
    return () => {
      active = false;
      activeRefreshRef.current?.abort();
      activeRefreshRef.current = null;
    };
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (
        document.visibilityState !== "hidden" &&
        !connectionRef.current.healthy
      ) {
        void refresh(true).catch(() => {});
      }
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

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

  const settleMutation = useCallback(
    async (scope: typeof connection.scope) => {
      if (connectionRef.current.scope !== scope) return;
      if (connectionRef.current.healthy) {
        await new Promise((resolve) => window.setTimeout(resolve, 200));
        if (
          connectionRef.current.scope !== scope ||
          connectionRef.current.healthy
        )
          return;
      }
      await refresh();
    },
    [refresh],
  );

  const projectReady = Boolean(project);
  const mcpCanComment = hasShareCapability(
    project?.capabilities ?? [],
    "comment",
  );
  useEffect(() => {
    if (!projectReady) {
      return;
    }
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
      canComment: mcpCanComment,
      addComment: async (bodyText) => {
        const who = sessionDisplayName("guest");
        const scope = connectionRef.current.scope;
        await createComment(projectKey, {
          body: bodyText,
          author: who,
          timelineStart: audioRef.current?.currentTime ?? 0,
        });
        await settleMutation(scope);
      },
    });
  }, [projectReady, mcpCanComment, projectKey, settleMutation]);

  const onPost = async () => {
    const who = commitCommentActor(author, "guest", setAuthor);
    if (!body.trim()) {
      setError("Comment body is required");
      return;
    }
    if (!beginInflight()) {
      return;
    }
    const scope = connectionRef.current.scope;
    try {
      await createComment(projectKey, {
        body: body.trim(),
        author: who,
        timelineStart: startSec,
        timelineEnd: null,
      });
      if (connectionRef.current.scope !== scope) return;
      setBody("");
      await settleMutation(scope);
    } catch (e) {
      if (connectionRef.current.scope === scope) setError(errorMessage(e));
    } finally {
      if (connectionRef.current.scope === scope) endInflight();
    }
  };

  if (loadError && !project) {
    return <ErrorScreen message={loadError} />;
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
    const who = commitCommentActor(author, "guest", setAuthor);
    if (!text.trim()) {
      setError("Reply body is required");
      return;
    }
    if (!beginInflight()) {
      return;
    }
    const scope = connectionRef.current.scope;
    try {
      await addCommentReply(projectKey, commentId, {
        body: text.trim(),
        author: who,
      });
      if (connectionRef.current.scope !== scope) return;
      setReplyDrafts((prev) => ({ ...prev, [commentId]: "" }));
      await settleMutation(scope);
    } catch (e) {
      if (connectionRef.current.scope === scope) setError(errorMessage(e));
    } finally {
      if (connectionRef.current.scope === scope) endInflight();
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
    const who = commitCommentActor(author, "guest", setAuthor);
    const scope = connectionRef.current.scope;
    try {
      await setCommentActionDone(projectKey, commentId, actionId, {
        done,
        by: who,
      });
      await settleMutation(scope);
    } catch (e) {
      if (connectionRef.current.scope === scope) setError(errorMessage(e));
    } finally {
      if (connectionRef.current.scope === scope) endInflight();
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
        <InlineError message={error ?? loadError ?? connection.error} />
        <label className="review-comment-filter">
          <input
            type="checkbox"
            checked={openOnly}
            onChange={(event) => setOpenOnly(event.target.checked)}
          />
          Open comments only
        </label>
        <ul className="comments-list review-comments">
          {visibleComments.map((c) => (
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
          {visibleComments.length === 0 && (
            <EmptyState as="li">
              {openOnly ? "No open comments." : "No comments yet."}
            </EmptyState>
          )}
        </ul>
      </div>
    </main>
  );
}
