import { useState } from "react";
import type { CommentRole } from "../shareMode";
import {
  capCommentName,
  GUEST_SESSION_LABEL,
  guestNameChosen,
  saveCommentAuthor,
  savedGuestName,
  sessionDisplayName,
} from "../utils/commentAuthor";

/**
 * The name a viewer comments and replies under. A guest who has not chosen one
 * types it into the Composer's name field; `choose` commits it with the first
 * post (blank keeps the saved name, else Guest) and remembers it in a key the
 * host never touches. Replies use `name` as it is. The host never chooses.
 */
export function useGuestName(role: CommentRole) {
  const isGuest = role === "guest";
  const [name, setName] = useState(() => sessionDisplayName(role));
  const [chosen, setChosen] = useState(() => !isGuest || guestNameChosen());
  const [draft, setDraft] = useState("");

  const rename = (next: string) => {
    const capped = capCommentName(next);
    if (!capped) return;
    setName(capped);
    if (isGuest) setChosen(true);
    saveCommentAuthor(capped, role);
  };

  const choose = (typed: string): string => {
    const capped = capCommentName(typed);
    const author = capped || savedGuestName() || GUEST_SESSION_LABEL;
    setName(author);
    setChosen(true);
    if (capped || !savedGuestName()) saveCommentAuthor(capped, "guest");
    return author;
  };

  return {
    name,
    setName,
    rename,
    chosen,
    showLine: isGuest && chosen,
    draft,
    setDraft,
    choose,
  };
}
