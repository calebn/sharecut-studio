import { beforeEach, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import type { CommentDraft } from "../state/types";
import { minimalProject } from "../test/fixtures";
import { beginCommentAnchorSession } from "./commentAnchorSession";

beforeEach(() => {
  useDawStore.getState().hydrate("/tmp/anchor", minimalProject());
  useDawStore.getState().setCommentMode(true);
});

it.each<CommentDraft | null>([
  null,
  { startSec: 2, endSec: null },
  {
    startSec: 2,
    endSec: 3,
    trackIds: ["host"],
    intervals: [{ start: 2, end: 3 }],
  },
])(
  "restores the full prior draft without revealing the Comments tab",
  (prior) => {
    useDawStore.getState().setCommentDraft(prior);
    const invalidated = vi.fn();
    const session = beginCommentAnchorSession(useDawStore, invalidated);
    session?.preview({ startSec: 4, endSec: 10 });
    expect(useDawStore.getState().commentDraft).toEqual({
      startSec: 4,
      endSec: 10,
    });
    expect(invalidated).not.toHaveBeenCalled();
    useDawStore.getState().setActiveTab("transcript");
    session?.cancel();
    session?.preview({ startSec: 12, endSec: null });
    session?.finish({ startSec: 15, endSec: null });
    session?.cancel();
    expect(useDawStore.getState().commentDraft).toBe(prior);
    expect(useDawStore.getState().activeTab).toBe("transcript");
  },
);

it("keeps the final draft after completion and ignores later cancellation", () => {
  const session = beginCommentAnchorSession(useDawStore, vi.fn());
  session?.preview({ startSec: 4, endSec: null });
  session?.finish({ startSec: 4, endSec: 10 });
  session?.cancel();
  expect(useDawStore.getState().commentDraft).toEqual({
    startSec: 4,
    endSec: 10,
  });
});

it.each(["draft", "mode", "path", "epoch"] as const)(
  "discards ownership on %s departure",
  (departure) => {
    const prior = { startSec: 2, endSec: null };
    useDawStore.getState().setCommentDraft(prior);
    const invalidated = vi.fn();
    const session = beginCommentAnchorSession(useDawStore, invalidated);
    session?.preview({ startSec: 4, endSec: 10 });
    if (departure === "draft")
      useDawStore.getState().setCommentDraft({ startSec: 20, endSec: null });
    if (departure === "mode") useDawStore.getState().setCommentMode(false);
    if (departure === "path")
      useDawStore.setState({ projectPath: "/tmp/other" });
    if (departure === "epoch")
      useDawStore.setState({
        projectEpoch: useDawStore.getState().projectEpoch + 1,
      });
    const departedDraft = useDawStore.getState().commentDraft;
    expect(invalidated).toHaveBeenCalledOnce();
    session?.cancel();
    session?.finish({ startSec: 30, endSec: 40 });
    expect(useDawStore.getState().commentDraft).toBe(departedDraft);
  },
);

it("cannot begin outside comment mode", () => {
  useDawStore.getState().setCommentMode(false);
  expect(beginCommentAnchorSession(useDawStore, vi.fn())).toBeNull();
});

it("discards a preview replaced synchronously by another store subscriber without revealing Comments", () => {
  useDawStore.getState().setActiveTab("transcript");
  const replacement = { startSec: 20, endSec: null };
  const detach = useDawStore.subscribe((state) => {
    if (state.commentDraft?.startSec === 4) state.setCommentDraft(replacement);
  });
  const invalidated = vi.fn();
  const session = beginCommentAnchorSession(useDawStore, invalidated);
  try {
    session?.preview({ startSec: 4, endSec: 10 });
    expect(invalidated).toHaveBeenCalledOnce();
    expect(useDawStore.getState().commentDraft).toBe(replacement);
    expect(useDawStore.getState().activeTab).toBe("transcript");
    session?.cancel();
    session?.finish({ startSec: 30, endSec: 40 });
    expect(useDawStore.getState().commentDraft).toBe(replacement);
  } finally {
    session?.cancel();
    detach();
  }
});
