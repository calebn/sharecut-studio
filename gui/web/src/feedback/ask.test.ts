import { describe, expect, it } from "vitest";
import { answerQuestion, askConfirm, useAskStore } from "./ask";

const REMOVE = {
  title: "Remove the Host track?",
  message: "Its clips leave the timeline.",
  keepLabel: "Keep track",
  actionLabel: "Remove track",
  danger: true,
};

function openId(): number {
  const pending = useAskStore.getState().pending;
  if (!pending) throw new Error("no open question");
  return pending.id;
}

describe("ask", () => {
  it("opens one confirm and resolves true only for the action", async () => {
    const yes = askConfirm(REMOVE);
    expect(useAskStore.getState().pending?.question).toEqual({
      kind: "confirm",
      ...REMOVE,
    });
    answerQuestion(openId(), true);
    await expect(yes).resolves.toBe(true);
    expect(useAskStore.getState().pending).toBeNull();

    const kept = askConfirm(REMOVE);
    answerQuestion(openId(), null);
    await expect(kept).resolves.toBe(false);
  });

  it("cancels an open question when a newer one opens, and ignores stale answers", async () => {
    const first = askConfirm(REMOVE);
    const firstId = openId();
    const second = askConfirm({ ...REMOVE, title: "Second?" });
    await expect(first).resolves.toBe(false);
    answerQuestion(firstId, true);
    expect(useAskStore.getState().pending?.question.title).toBe("Second?");
    answerQuestion(openId(), true);
    await expect(second).resolves.toBe(true);
  });
});
