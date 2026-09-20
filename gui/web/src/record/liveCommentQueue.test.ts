import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLiveComment,
  commentsQueueKey,
  dequeueComment,
  enqueueComment,
  LIVE_COMMENT_QUEUE_MAX,
  liveTakeOpen,
  loadCommentQueue,
  MARKER_BODY,
  postLiveComment,
} from "./liveCommentQueue";

describe("liveCommentQueue", () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it("stores reconnect upserts under record:{token}:comments", () => {
    const comment = buildLiveComment({
      body: MARKER_BODY,
      takeIndex: 0,
      recordingMs: 1234,
      author: "p_g",
      id: "live-queued-1",
    });
    enqueueComment("tok", comment);
    enqueueComment("tok", comment);
    expect(commentsQueueKey("tok")).toBe("record:tok:comments");
    expect(loadCommentQueue("tok")).toHaveLength(1);
    dequeueComment("tok", "live-queued-1");
    expect(loadCommentQueue("tok")).toEqual([]);
  });

  it("caps the offline queue at the server max", () => {
    for (let i = 0; i < LIVE_COMMENT_QUEUE_MAX + 3; i += 1) {
      enqueueComment(
        "tok",
        buildLiveComment({
          body: MARKER_BODY,
          takeIndex: 0,
          recordingMs: i,
          author: "p_g",
          id: `live-n${i}`,
        }),
      );
    }
    const rows = loadCommentQueue("tok");
    expect(rows).toHaveLength(LIVE_COMMENT_QUEUE_MAX);
    expect(rows[0]?.id).toBe("live-n3");
    expect(rows.at(-1)?.id).toBe(`live-n${LIVE_COMMENT_QUEUE_MAX + 2}`);
  });

  it("enqueues before send", () => {
    const send = vi.fn(() => true);
    const comment = postLiveComment(send, "tok", {
      body: MARKER_BODY,
      takeIndex: 0,
      recordingMs: 10,
      author: "p_g",
    });
    expect(comment.id.startsWith("live-")).toBe(true);
    expect(send).toHaveBeenCalledWith("Comment", comment);
    expect(loadCommentQueue("tok")).toHaveLength(1);
  });

  it("returns false when sessionStorage save fails", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    const ok = enqueueComment(
      "tok",
      buildLiveComment({
        body: MARKER_BODY,
        takeIndex: 0,
        recordingMs: 0,
        author: "p_g",
        id: "live-q",
      }),
    );
    expect(ok).toBe(false);
    setItem.mockRestore();
  });

  it("treats recording and paused as open takes", () => {
    expect(liveTakeOpen("recording")).toBe(true);
    expect(liveTakeOpen("paused")).toBe(true);
    expect(liveTakeOpen("lobby")).toBe(false);
  });
});
