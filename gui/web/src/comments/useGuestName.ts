import { useState } from "react";
import type { CommentRole } from "../shareMode";
import {
  COMMENT_NAME_MAX,
  GUEST_SESSION_LABEL,
  guestNameChosen,
  markGuestNameChosen,
  saveCommentAuthor,
  sessionDisplayName,
} from "../utils/commentAuthor";

/**
 * A guest's comment name: asked once, on the first Post, and remembered.
 * `authorForPost` returns the name to post under, or null while it opens the
 * name step instead; the host never gets a step.
 */
export function useGuestName(role: CommentRole) {
  const isGuest = role === "guest";
  const [name, setName] = useState(() => sessionDisplayName(role));
  const [chosen, setChosen] = useState(() => !isGuest || guestNameChosen());
  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState("");

  const rename = (next: string) => {
    const capped = next.trim().slice(0, COMMENT_NAME_MAX);
    setName(capped);
    saveCommentAuthor(capped);
  };

  const choose = (typed: string): string => {
    const author =
      typed.trim().slice(0, COMMENT_NAME_MAX) || GUEST_SESSION_LABEL;
    setName(author);
    setChosen(true);
    setAsking(false);
    markGuestNameChosen();
    return author;
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
    rename,
    chosen,
    showLine: isGuest && chosen,
    asking,
    draft,
    setDraft,
    cancel: () => setAsking(false),
    choose,
    authorForPost,
  };
}
