import { useState } from "react";
import { seekTransport } from "../../commands/seek";
import { commentTimeLabel, useCommentActions } from "../../comments";
import { canReply, canSetAction, commentRole } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import type { Selection } from "../../types/project";
import { Button, DefItem, DefinitionList, InlineError } from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";

const section = (
  id: string,
  ...controls: React.ReactNode[]
): InspectorSection => ({
  id,
  rows: controls.map((control, i) => ({ id: `${id}${i}`, control })),
});

export function useCommentSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const isComment = selection?.kind === "comment";
  const { project, guestMode, shareCapabilities, projectPath } = useDaw(
    (s) => ({
      project: isComment ? s.project : null,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
      projectPath: s.projectPath,
    }),
  );
  const role = commentRole(projectPath, guestMode);
  const [replyBody, setReplyBody] = useState("");
  const { busy, error, resolve, reply, toggleAction } = useCommentActions({
    role,
  });
  if (selection?.kind !== "comment") return null;
  const comment = project?.comments?.find((c) => c.id === selection.id);
  if (!comment)
    return [
      section("gone", <p className="ui-field-hint">Comment not found</p>),
    ];
  if (
    comment.edit_decision_id &&
    project?.pending_edits.some((e) => e.id === comment.edit_decision_id)
  )
    return null;

  const timeLabel = commentTimeLabel(comment);
  const busyReason = busy ? BUSY_REASON : undefined;
  const replies = comment.replies ?? [];
  const sections: InspectorSection[] = [
    section(
      "facts",
      <div className="inspector edit-sheet-part">
        <DefinitionList>
          <DefItem label="Time">
            <Button onClick={() => void seekTransport(comment.timeline_start)}>
              {timeLabel}
            </Button>
          </DefItem>
          <DefItem label="Author">{comment.author}</DefItem>
          <DefItem label="Status">
            {comment.resolved
              ? `Resolved${comment.resolved_by ? ` by ${comment.resolved_by}` : ""}`
              : "Open"}
          </DefItem>
          {comment.track_ids.length > 0 ? (
            <DefItem label="Tracks">{comment.track_ids.join(", ")}</DefItem>
          ) : null}
        </DefinitionList>
      </div>,
      <p className="inspector-body">{comment.body}</p>,
    ),
  ];
  if (comment.action_items.length > 0)
    sections.push(
      section(
        "actions",
        <ul className="inspector-actions interactive" aria-label="Action items">
          {comment.action_items.map((a) => (
            <li key={a.id}>
              <label>
                <input
                  type="checkbox"
                  checked={a.done}
                  disabled={
                    busy || !canSetAction(projectPath, shareCapabilities)
                  }
                  onChange={(e) =>
                    void toggleAction(comment, a.id, e.target.checked)
                  }
                />
                <span className={a.done ? "done" : ""}>{a.text}</span>
                {a.done && a.completed_by ? (
                  <span className="comment-meta"> ({a.completed_by})</span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>,
      ),
    );
  if (replies.length > 0)
    sections.push(
      section(
        "replies",
        <ul className="comment-replies" aria-label="Replies">
          {replies.map((r) => (
            <li key={r.id}>
              <span className="comment-card-author">{r.author}</span>
              <span className="comment-card-body">{r.body}</span>
            </li>
          ))}
        </ul>,
      ),
    );
  if (canReply(projectPath, guestMode, shareCapabilities))
    sections.push(
      section(
        "reply",
        <div className="comment-reply-compose">
          <input
            aria-label="Reply to comment"
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            placeholder="Reply…"
            disabled={busy}
          />
          <Button
            disabledReason={busyReason}
            onClick={() =>
              void reply(comment, replyBody).then((ok) => {
                if (ok) setReplyBody("");
              })
            }
          >
            Reply
          </Button>
        </div>,
      ),
    );
  const verbs = [
    error ? <InlineError key="error" message={error} /> : null,
    role === "guest" ? null : (
      <Button
        key="resolve"
        variant="primary"
        disabledReason={busyReason}
        onClick={() => void resolve(comment, !comment.resolved)}
      >
        {comment.resolved ? "Reopen" : "Resolve"}
      </Button>
    ),
  ].filter(Boolean);
  if (verbs.length) sections.push(section("resolve", ...verbs));
  return sections;
}
