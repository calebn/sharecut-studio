import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject, sampleComment } from "../test/fixtures";
import { useCommentActions } from "./useCommentActions";

const addCommentReply = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({
  addCommentReply,
  setCommentActionDone: vi.fn(),
}));

const key = shareProjectKey("tok");

beforeEach(() => {
  addCommentReply.mockReset();
  useDawStore
    .getState()
    .hydrate(key, minimalProject(), "comment", [
      "play",
      "view",
      "comment",
      "reply",
    ]);
});

describe("a guest's reply", () => {
  it("keeps one key for the same words on the same comment until it is sent, then takes a new one", async () => {
    addCommentReply
      .mockRejectedValueOnce(new Error("The host didn't answer."))
      .mockResolvedValue(undefined);
    const { result } = renderHook(
      () => useCommentActions({ role: "guest", author: "Ana" }),
      {
        wrapper: ({ children }) => (
          <DawProvider projectPath={key} initialProject={minimalProject()}>
            {children}
          </DawProvider>
        ),
      },
    );
    const one = sampleComment({ id: "c1" });
    const two = sampleComment({ id: "c2" });
    const send = async (comment: typeof one, text: string) => {
      await act(async () => {
        await result.current.reply(comment, text);
      });
      return addCommentReply.mock.lastCall?.[2].postKey;
    };
    const first = await send(one, "Thanks");
    expect(await send(one, "Thanks")).toBe(first);
    expect(await send(one, "Thanks")).not.toBe(first);
    expect(await send(two, "Thanks")).not.toBe(first);
  });
});
