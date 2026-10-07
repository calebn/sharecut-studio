import { describe, expect, it } from "vitest";
import { answerQuestion, askConfirm, askText, useAskStore } from "./ask";

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

  it("trims typed text and treats blank or cancel as null", async () => {
    const text = {
      title: "Open project",
      label: "Path",
      submitLabel: "Open project",
      requiredMessage: "Enter a path.",
    };
    const typed = askText(text);
    answerQuestion(openId(), "  /tmp/ep.json ");
    await expect(typed).resolves.toBe("/tmp/ep.json");

    const blank = askText(text);
    answerQuestion(openId(), "   ");
    await expect(blank).resolves.toBeNull();
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
