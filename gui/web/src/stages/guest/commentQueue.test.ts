import { describe, expect, it } from "vitest";
import {
  type CommentStatus,
  dueToSend,
  glyphOf,
  type QueuedComment,
  type QueueEvent,
  queueReducer,
  saveOf,
  waitingCount,
} from "./commentQueue";

const make = (id: string, status: CommentStatus): QueuedComment => ({
  id,
  body: id,
  at: 10,
  name: "Guest",
  status,
});

describe("queueReducer", () => {
  it("queues a post after the others", () => {
    const next = queueReducer([make("a", "sent")], {
      type: "post",
      comment: { id: "b", body: "b", at: 20, name: "Dana" },
    });
    expect(next.map((c) => [c.id, c.status])).toEqual([
      ["a", "sent"],
      ["b", "queued"],
    ]);
  });

  it.each<[string, CommentStatus, QueueEvent["type"], CommentStatus]>([
    ["starts sending", "queued", "sendStarted", "sending"],
    ["is sent", "sending", "sent", "sent"],
    ["fails", "sending", "failed", "failed"],
    ["is retried", "failed", "retry", "queued"],
    ["cannot be sent before it starts", "queued", "sent", "queued"],
    ["cannot start twice", "sending", "sendStarted", "sending"],
    ["stays sent", "sent", "failed", "sent"],
    ["cannot retry unless failed", "queued", "retry", "queued"],
  ])("a comment that %s", (_name, from, type, to) => {
    const event = { type, id: "a" } as QueueEvent;
    expect(
      queueReducer([make("a", from), make("b", "queued")], event)[0]?.status,
    ).toBe(to);
  });

  it("leaves other comments alone and ignores an unknown id", () => {
    const queue = [make("a", "queued")];
    expect(queueReducer(queue, { type: "sendStarted", id: "zz" })).toEqual(
      queue,
    );
  });
});

describe("dueToSend", () => {
  it.each<[string, CommentStatus[], boolean, string | null]>([
    ["offline sends nothing", ["queued"], false, null],
    ["online sends the oldest queued", ["sent", "queued", "queued"], true, "1"],
    ["one at a time", ["sending", "queued"], true, null],
    ["a failed one is not retried by itself", ["failed"], true, null],
    ["nothing queued", ["sent"], true, null],
    ["empty", [], true, null],
  ])("%s", (_name, statuses, online, id) => {
    expect(
      dueToSend(
        statuses.map((s, i) => make(String(i), s)),
        online,
      ),
    ).toBe(id);
  });
});

describe("reconnecting", () => {
  it("sends the queue by itself, in order, once back online", () => {
    let queue: readonly QueuedComment[] = [];
    for (const id of ["a", "b"]) {
      queue = queueReducer(queue, {
        type: "post",
        comment: { id, body: id, at: 1, name: "G" },
      });
    }
    expect(dueToSend(queue, false)).toBeNull();
    const sent: string[] = [];
    for (let id = dueToSend(queue, true); id; id = dueToSend(queue, true)) {
      sent.push(id);
      queue = queueReducer(queue, { type: "sendStarted", id });
      queue = queueReducer(queue, { type: "sent", id });
    }
    expect(sent).toEqual(["a", "b"]);
    expect(waitingCount(queue)).toBe(0);
  });
});

describe("glyphOf", () => {
  it.each<[CommentStatus, "clock" | "alert" | null]>([
    ["queued", "clock"],
    ["sending", "clock"],
    ["sent", null],
    ["failed", "alert"],
  ])("%s", (status, glyph) => {
    expect(glyphOf(status)).toBe(glyph);
  });
});

describe("saveOf", () => {
  it.each<[string, CommentStatus[], boolean, object]>([
    [
      "offline counts the waiting",
      ["queued", "queued", "sent"],
      false,
      { state: "offline", waiting: 2 },
    ],
    [
      "offline with nothing waiting",
      ["sent"],
      false,
      { state: "offline", waiting: 0 },
    ],
    ["draining", ["sending", "queued"], true, { state: "saving" }],
    ["a refused comment", ["failed", "sent"], true, { state: "failed" }],
    ["all sent", ["sent"], true, { state: "saved" }],
  ])("%s", (_name, statuses, online, expected) => {
    expect(
      saveOf(
        statuses.map((s, i) => make(String(i), s)),
        online,
      ),
    ).toEqual(expected);
  });
});
