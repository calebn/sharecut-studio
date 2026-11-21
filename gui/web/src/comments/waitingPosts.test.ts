import { describe, expect, it } from "vitest";
import type { OutboxRow, OutboxView } from "../state/outboxStore";
import { sampleComment } from "../test/fixtures";
import { withWaitingPosts } from "./waitingPosts";

const KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const comment = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  id: KEY,
  kind: "comment",
  body: "Kept words",
  author: "Ana",
  created_at: Date.parse("2026-11-21T10:00:00Z"),
  anchor: {
    timeline_start: 20,
    timeline_end: null,
    timeline_spans: null,
    track_ids: [],
    edit_decision_id: null,
  },
  ...over,
});
const view = (rows: OutboxRow[], sending: string[] = []): OutboxView => ({
  rows,
  returned: [],
  sending: new Set(sending),
  loaded: true,
});

describe("withWaitingPosts", () => {
  it("lists a kept comment among the host's, at its time, under the id it will keep", () => {
    const host = [
      sampleComment({ id: "early", timeline_start: 5 }),
      sampleComment({ id: "late", timeline_start: 50 }),
    ];
    const merged = withWaitingPosts(host, view([comment()]));
    expect(merged.comments.map((c) => c.id)).toEqual([
      "early",
      `g-${KEY}`,
      "late",
    ]);
    expect(merged.waiting.get(`g-${KEY}`)).toMatchObject({ state: "waiting" });
    expect(merged.serverId(`g-${KEY}`)).toBeNull();
  });

  it("says Sending for the row on its way", () => {
    const merged = withWaitingPosts([], view([comment()], [KEY]));
    expect(merged.waiting.get(`g-${KEY}`)?.state).toBe("sending");
  });

  it("shows the real comment once it landed, under the same id, with its server id on hand", () => {
    const landed = sampleComment({
      id: `g-share1-${KEY}`,
      body: "Kept words",
      timeline_start: 20,
    });
    const merged = withWaitingPosts([landed], view([comment()]));
    expect(merged.comments.map((c) => c.id)).toEqual([`g-${KEY}`]);
    expect(merged.waiting.size).toBe(0);
    expect(merged.serverId(`g-${KEY}`)).toBe(`g-share1-${KEY}`);
  });

  it("holds a kept reply on its comment until the host takes it", () => {
    const reply = comment({
      kind: "reply",
      anchor: undefined,
      parent_comment_id: "c1",
    });
    const open = withWaitingPosts([sampleComment({ id: "c1" })], view([reply]));
    expect(open.waitingReplies.get("c1")).toHaveLength(1);
    const landed = sampleComment({
      id: "c1",
      replies: [
        { id: `g-share1-${KEY}`, author: "Ana", body: "x", created_at: "" },
      ],
    });
    expect(withWaitingPosts([landed], view([reply])).waitingReplies.size).toBe(
      0,
    );
  });
});
