import { useState } from "react";
import {
  CommentAnchorChip,
  CommentCompose,
  commentPostedStatus,
  usePostComment,
} from "../comments";
import { commentRole } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { InlineError } from "../ui";
import { sessionDisplayName } from "../utils/commentAuthor";

/**
 * The phone Listen view's comment field, docked above the mode bar: type,
 * then Post comment, at the playhead or the time on the chip.
 */
export function ListenCommentComposer({ guestShare }: { guestShare: boolean }) {
  const { projectPath, guestMode, announceStatus } = useDaw((s) => ({
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    announceStatus: s.announceStatus,
  }));
  const [body, setBody] = useState("");
  const { busy, error, post } = usePostComment();

  const onPost = async () => {
    const result = await post({
      body,
      author: sessionDisplayName(
        commentRole(projectPath, guestMode, guestShare),
      ),
    });
    if (!result.ok) return;
    setBody("");
    announceStatus(commentPostedStatus(result.comment));
  };

  return (
    <section className="listen-comment-dock" aria-label="Add a comment">
      <InlineError message={error} />
      <CommentCompose
        className="comment-compose comment-compose--dock"
        body={body}
        onBodyChange={setBody}
        busy={busy}
        onSubmit={() => void onPost()}
        anchor={<CommentAnchorChip />}
        bodyPlaceholder="Add a comment…"
        bodyRows={1}
      />
    </section>
  );
}
