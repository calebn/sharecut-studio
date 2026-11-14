import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
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

describe("usePostComment while the selected words are refreshing", () => {
  beforeEach(() => {
    createComment.mockReset();
    useDawStore.getState().hydrate(
      "share:tok",
      minimalProject({
        transcript: {
          utterances: [
            {
              track_id: "speaker",
              speaker: "Speaker",
              start: 1,
              end: 7,
              text: "one two",
            },
          ],
        },
        meta: {
          name: "t",
          workspace_dir: "/tmp",
          hydration: { transcript_words: false },
        },
      }),
      "comment",
      ["view", "comment"],
    );
    useDawStore.setState({
      playheadSec: 40,
      selection: {
        kind: "transcriptRange",
        trackId: "speaker",
        sourceId: null,
        startWordIndex: 0,
        endWordIndex: 1,
      },
    });
  });

  it("posts nothing, says why, and does not use the playhead", async () => {
    const { result } = renderHook(() => usePostComment());
    let posted: Awaited<ReturnType<typeof result.current.post>> | undefined;
    await act(async () => {
      posted = await result.current.post({ body: "Hi", author: "Sam" });
    });
    expect(posted).toEqual({ ok: false });
    expect(result.current.error).toBe(
      "Refreshing the transcript. Try again in a moment.",
    );
    expect(createComment).not.toHaveBeenCalled();
  });
});
