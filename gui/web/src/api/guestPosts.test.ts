import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxRow } from "../state/outboxStore";
import { sampleComment } from "../test/fixtures";
import { addCommentReply, createComment, sendGuestPost } from "./comments";

const merged = vi.hoisted(() => ({
  comment: vi.fn(),
  reply: vi.fn(),
}));
vi.mock("../document/applyDocumentUpdate", () => ({
  mergeReturnedComment: merged.comment,
  mergeReturnedReply: merged.reply,
  mergeGuestActionDone: vi.fn(),
}));
const outbox = vi.hoisted(() => ({ appendOutbox: vi.fn(async () => true) }));
vi.mock("../state/outboxStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/outboxStore")>()),
  appendOutbox: outbox.appendOutbox,
}));
const reach = vi.hoisted(() => ({ cause: null as "host" | "device" | null }));
vi.mock("../state/hostReach", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/hostReach")>()),
  hostCauseNow: () => reach.cause,
}));

const KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const commentRow: OutboxRow = {
  id: KEY,
  kind: "comment",
  body: "Hello",
  author: "Ana",
  created_at: 5,
  anchor: {
    timeline_start: 12,
    timeline_end: 14,
    timeline_spans: [{ start: 12, end: 14 }],
    track_ids: ["t1"],
    edit_decision_id: null,
  },
};
const replyRow: OutboxRow = {
  id: KEY,
  kind: "reply",
  body: "Thanks",
  author: "Ana",
  created_at: 6,
  parent_comment_id: "c1",
};

type Seen = { url: string; body: unknown };
let seen: Seen[];
let answer: () => Promise<Response>;

const json = (status: number, body: unknown, code?: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: code ? { "X-Sharecut-Error-Code": code } : {},
  });

beforeEach(() => {
  seen = [];
  reach.cause = null;
  merged.comment.mockReset();
  merged.reply.mockReset();
  outbox.appendOutbox.mockClear();
  answer = async () => json(200, { comment: sampleComment({ id: "g-s-1" }) });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return answer();
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("sendGuestPost", () => {
  it("sends a comment with its key and everything it was anchored to", async () => {
    const outcome = await sendGuestPost("tok", commentRow);
    expect(outcome).toMatchObject({ status: "sent" });
    expect(seen).toEqual([
      {
        url: "/api/review/tok/comments",
        body: {
          comment_id: KEY,
          body: "Hello",
          author: "Ana",
          timeline_start: 12,
          timeline_end: 14,
          edit_decision_id: null,
          track_ids: ["t1"],
          timeline_spans: [{ start: 12, end: 14 }],
        },
      },
    ]);
    expect(merged.comment).toHaveBeenCalledOnce();
  });

  it("sends a reply to the comment the server named, with its own key", async () => {
    answer = async () =>
      json(200, { comment_id: "c1", reply: { id: "g-s-1", body: "Thanks" } });
    const outcome = await sendGuestPost("tok", replyRow, "c 1");
    expect(outcome).toMatchObject({ status: "sent" });
    expect(seen[0]).toEqual({
      url: "/api/review/tok/comments/c%201/replies",
      body: { reply_id: KEY, body: "Thanks", author: "Ana" },
    });
    expect(merged.reply).toHaveBeenCalledWith("c1", expect.anything());
  });

  it("does not send a reply whose comment has no server id yet", async () => {
    expect(await sendGuestPost("tok", replyRow)).toMatchObject({
      status: "retry",
      keep: true,
    });
    expect(seen).toEqual([]);
  });

  it.each([
    [
      "no network",
      () => Promise.reject(new TypeError("fetch failed")),
      "retry",
      true,
    ],
    ["the relay says 502", async () => json(502, {}), "retry", true],
    ["the relay says 504", async () => json(504, {}), "retry", true],
    ["a 503 from the relay", async () => json(503, {}), "retry", true],
    ["a busy host", async () => json(503, {}, "project_busy"), "retry", true],
    ["a rate limit", async () => json(429, {}), "retry", true],
    ["a request timeout", async () => json(408, {}), "retry", true],
    [
      "an answer that cannot be read",
      async () => new Response("<html>", { status: 200 }),
      "retry",
      true,
    ],
    [
      "a server error",
      async () => json(500, { detail: "boom" }),
      "retry",
      false,
    ],
    [
      "a link that is gone",
      async () => json(404, {}, "share_not_found"),
      "retry",
      false,
    ],
    [
      "a link that no longer comments",
      async () => json(403, {}, "share_capability_required"),
      "refused",
      undefined,
    ],
    [
      "a body that is too long",
      async () => json(422, {}),
      "refused",
      undefined,
    ],
    [
      "a comment that is gone",
      async () => json(404, {}, "comment_not_found"),
      "refused",
      undefined,
    ],
  ])("treats %s as %s", async (_name, respond, status, keep) => {
    answer = respond as () => Promise<Response>;
    const outcome = await sendGuestPost("tok", commentRow);
    expect(outcome.status).toBe(status);
    if (outcome.status === "retry") expect(outcome.keep).toBe(keep);
  });

  it("gives up on a send that is not answered, and counts it as kept", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetch).mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
      );
      const pending = sendGuestPost("tok", commentRow);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toMatchObject({ status: "retry", keep: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a guest's new comment", () => {
  const post = () =>
    createComment("share:tok", {
      body: "Hello",
      author: "Ana",
      timelineStart: 12,
      postKey: KEY,
    });

  it("is posted when the host answers", async () => {
    expect(await post()).toMatchObject({ id: "g-s-1" });
    expect(outbox.appendOutbox).not.toHaveBeenCalled();
  });

  it("is kept under the key it was sent with when the host does not answer", async () => {
    answer = () => Promise.reject(new TypeError("fetch failed"));
    expect(await post()).toEqual({ kept: true, id: KEY });
    expect(outbox.appendOutbox).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({ id: KEY, kind: "comment", body: "Hello" }),
    );
  });

  it("is kept at once, with no request, while the host is known to be away", async () => {
    reach.cause = "host";
    expect(await post()).toEqual({ kept: true, id: KEY });
    expect(seen).toEqual([]);
  });

  it("stays in the field with the host's words when it is refused", async () => {
    answer = async () =>
      json(403, { detail: "No comments here." }, "share_capability_required");
    await expect(post()).rejects.toMatchObject({
      status: 403,
      message: "No comments here.",
    });
    expect(outbox.appendOutbox).not.toHaveBeenCalled();
  });

  it("stays in the field after a server error, to be tried again under the same key", async () => {
    answer = async () => json(500, { detail: "boom" });
    await expect(post()).rejects.toMatchObject({ status: 500 });
    expect(outbox.appendOutbox).not.toHaveBeenCalled();
  });

  it("stays in the field when this browser cannot keep it", async () => {
    answer = () => Promise.reject(new TypeError("fetch failed"));
    outbox.appendOutbox.mockResolvedValueOnce(false);
    await expect(post()).rejects.toMatchObject({ code: "network_error" });
  });
});

describe("a guest's reply", () => {
  it("is kept for later when the host does not answer", async () => {
    answer = () => Promise.reject(new TypeError("fetch failed"));
    const kept = await addCommentReply("share:tok", "c1", {
      body: "Thanks",
      author: "Ana",
      postKey: KEY,
    });
    expect(kept).toEqual({ kept: true, id: KEY });
    expect(outbox.appendOutbox).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({ kind: "reply", parent_comment_id: "c1" }),
    );
  });

  it("returns nothing once it is posted", async () => {
    answer = async () =>
      json(200, { comment_id: "c1", reply: { id: "g-s-1", body: "Thanks" } });
    expect(
      await addCommentReply("share:tok", "c1", {
        body: "Thanks",
        author: "Ana",
      }),
    ).toBeUndefined();
  });
});
