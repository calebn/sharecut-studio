import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePostComment } from "./usePostComment";

const createComment = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ createComment }));

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
