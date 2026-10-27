import type { CommentCardData } from "../system/CommentCard";

export const OPEN_COMMENT: CommentCardData = {
  id: "c1",
  author: "Rosa",
  at: { start: 724 },
  body: "Can we lose the cough before the story starts?",
  resolved: false,
  replies: [],
  actions: [],
};

export const COMMENT_WITH_ACTIONS: CommentCardData = {
  ...OPEN_COMMENT,
  replies: [
    { id: "r1", author: "Sam", body: "On it. I will trim it and re-level." },
    { id: "r2", author: "Rosa", body: "Thank you." },
  ],
  actions: [
    { id: "a1", text: "Trim the cough", done: true, doneBy: "Sam" },
    { id: "a2", text: "Re-level the intro", done: false },
  ],
};

export const RESOLVED_COMMENT: CommentCardData = {
  ...COMMENT_WITH_ACTIONS,
  resolved: true,
  resolvedBy: "Sam",
  actions: COMMENT_WITH_ACTIONS.actions.map((a) => ({
    ...a,
    done: true,
    doneBy: "Sam",
  })),
};
