import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePostComment } from "./usePostComment";

const createComment = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ createComment }));

describe("usePostComment", () => {
  it("shows no error from a post that failed after cancel", async () => {
    let fail!: (reason: Error) => void;
    createComment.mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    const { result } = renderHook(() => usePostComment());
    let outcome!: Promise<unknown>;
    act(() => {
      outcome = result.current.post({ body: "Late", author: "Sam" });
    });
    expect(result.current.busy).toBe(true);
    act(() => result.current.cancel());
    expect(result.current.busy).toBe(false);
    await act(async () => {
      fail(new Error("Server said no"));
      await outcome;
    });
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
  });
});

describe("usePostComment track scope", () => {
  it("sends the tracks the person chose, else the whole session", async () => {
    createComment.mockResolvedValue(null);
    const { result } = renderHook(() => usePostComment());
    await act(async () => {
      await result.current.post({ body: "A", author: "Sam", trackIds: ["t2"] });
    });
    expect(createComment).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ trackIds: ["t2"] }),
    );
    await act(async () => {
      await result.current.post({ body: "B", author: "Sam", trackIds: [] });
    });
    expect(createComment).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ trackIds: [] }),
    );
  });
});
