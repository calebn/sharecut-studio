import type { DawState } from "../state/types";

export type CommentAnchor = Readonly<{
  startSec: number;
  endSec: number | null;
}>;

export interface CommentAnchorSession {
  preview(anchor: CommentAnchor): void;
  finish(anchor: CommentAnchor): void;
  cancel(): void;
}

export interface CommentAnchorGesture {
  begin(onInvalidated: () => void): CommentAnchorSession | null;
}

type AnchorState = Pick<
  DawState,
  | "projectPath"
  | "projectEpoch"
  | "commentMode"
  | "commentDraft"
  | "setCommentDraft"
  | "setActiveTab"
>;

type AnchorStore = {
  getState(): AnchorState;
  subscribe(listener: (state: AnchorState) => void): () => void;
};

export function beginCommentAnchorSession(
  store: AnchorStore,
  onInvalidated: () => void,
): CommentAnchorSession | null {
  const origin = store.getState();
  if (!origin.commentMode) return null;
  let ownedDraft = origin.commentDraft;
  let ended = false;
  const valid = (state: AnchorState) =>
    state.projectPath === origin.projectPath &&
    state.projectEpoch === origin.projectEpoch &&
    state.commentMode &&
    state.commentDraft === ownedDraft;
  const unsubscribe = store.subscribe((state) => {
    if (!ended && !valid(state)) {
      ended = true;
      unsubscribe();
      onInvalidated();
    }
  });
  const preview = (anchor: CommentAnchor) => {
    if (ended) return;
    const state = store.getState();
    if (!valid(state)) {
      ended = true;
      unsubscribe();
      onInvalidated();
      return;
    }
    ownedDraft = { ...anchor };
    state.setCommentDraft(ownedDraft);
    if (!ended) store.getState().setActiveTab("comments");
  };
  return {
    preview,
    finish(anchor) {
      preview(anchor);
      ended = true;
      unsubscribe();
    },
    cancel() {
      if (ended) return;
      ended = true;
      unsubscribe();
      const state = store.getState();
      if (valid(state)) state.setCommentDraft(origin.commentDraft);
    },
  };
}
