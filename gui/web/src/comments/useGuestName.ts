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
 * The name a viewer comments and replies under, and a guest's one-time
 * "who is commenting" step: asked on the first comment Post, remembered in a
 * key the host never touches. `authorForPost` returns the name to post under,
 * or null while it opens the name step instead; replies use `name` as it is
 * (the chosen name, else Guest). The host never gets a step.
 */
export function useGuestName(role: CommentRole) {
  const isGuest = role === "guest";
  const [name, setName] = useState(() => sessionDisplayName(role));
  const [chosen, setChosen] = useState(() => !isGuest || guestNameChosen());
  const [asking, setAsking] = useState(false);
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
    setAsking(false);
    if (capped || !savedGuestName()) saveCommentAuthor(capped, "guest");
    return author;
  };

  /** Post as Guest: this comment is Guest's even if a name was saved since
   *  the step opened (another tab); a saved name is never overwritten. */
  const postAsGuest = (): string => {
    setName(GUEST_SESSION_LABEL);
    setChosen(true);
    setAsking(false);
    if (!savedGuestName()) saveCommentAuthor("", "guest");
    return GUEST_SESSION_LABEL;
  };

  const authorForPost = (): string | null => {
    if (asking) return choose(draft);
    if (!chosen) {
      setAsking(true);
      return null;
    }
    return name;
  };

  return {
    name,
    setName,
    rename,
    chosen,
    showLine: isGuest && chosen,
    asking,
    draft,
    setDraft,
    choose,
    postAsGuest,
    authorForPost,
  };
}
