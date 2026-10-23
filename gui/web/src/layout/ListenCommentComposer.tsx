import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CommentAnchorChip,
  CommentAuthorLine,
  CommentCompose,
  commentPostedStatus,
  GuestNameStep,
  useGuestName,
  usePostComment,
} from "../comments";
import { commentRole } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { InlineError } from "../ui";

function isTextField(el: Element): boolean {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
}

/**
 * The phone Listen view's comment field, docked above the mode bar: type,
 * then Post comment, at the playhead or the time on the chip. Posting closes
 * the keyboard on purpose: the guest goes back to listening, and the keyboard
 * would cover half the view. A guest's first Post asks for a name once
 * (Post as Guest stays Guest); afterwards a "Commenting as" line changes it.
 */
export function ListenCommentComposer({ guestShare }: { guestShare: boolean }) {
  const { projectPath, guestMode, announceStatus } = useDaw((s) => ({
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    announceStatus: s.announceStatus,
  }));
  const guest = useGuestName(commentRole(projectPath, guestMode, guestShare));
  const [body, setBody] = useState("");
  const { busy, error, post } = usePostComment();
  const dockRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // A tap on a dock button keeps the text field focused (the keyboard and the
  // dock's height stay put), so the button does not move before the click.
  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const keepFieldFocus = (e: MouseEvent) => {
      const active = document.activeElement;
      if (
        e.target instanceof Element &&
        e.target.closest("button") &&
        active &&
        isTextField(active) &&
        dock.contains(active)
      ) {
        e.preventDefault();
      }
    };
    dock.addEventListener("mousedown", keepFieldFocus);
    return () => dock.removeEventListener("mousedown", keepFieldFocus);
  }, []);

  useLayoutEffect(() => {
    if (guest.asking) dockRef.current?.scrollIntoView?.({ block: "end" });
  }, [guest.asking]);

  const send = async (author: string) => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && dockRef.current?.contains(focused)) {
      focused.blur();
    }
    const posted = body;
    const result = await post({ body: posted, author });
    if (!result.ok) {
      bodyRef.current?.focus();
      return;
    }
    setBody((now) => (now === posted ? "" : now));
    announceStatus(commentPostedStatus(result.comment));
  };

  const onPost = () => {
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement &&
      active.closest(".comment-author-edit")
    ) {
      const renamed = active.value.trim();
      active.blur();
      if (renamed) {
        void send(renamed);
        return;
      }
    }
    const author = guest.authorForPost();
    if (author !== null) void send(author);
  };

  return (
    <section
      ref={dockRef}
      className="listen-comment-dock"
      aria-label="Add a comment"
    >
      <InlineError message={error} />
      {guest.showLine ? (
        <CommentAuthorLine name={guest.name} onChange={guest.rename} />
      ) : null}
      <CommentCompose
        className="comment-compose comment-compose--dock"
        body={body}
        bodyRef={bodyRef}
        onBodyChange={setBody}
        busy={busy}
        onSubmit={onPost}
        anchor={<CommentAnchorChip />}
        bodyPlaceholder="Add a comment…"
        bodyRows={1}
        hideSubmit={guest.asking}
      >
        {guest.asking ? (
          <GuestNameStep
            name={guest.draft}
            onNameChange={guest.setDraft}
            onConfirm={onPost}
            onPostAsGuest={() => void send(guest.postAsGuest())}
            busy={busy}
            postDisabledReason={
              body.trim() ? undefined : "Write a comment to post."
            }
          />
        ) : null}
      </CommentCompose>
    </section>
  );
}
