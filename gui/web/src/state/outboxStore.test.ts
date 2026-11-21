import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubIndexedDb } from "../test/fakeIndexedDb";
import { markLinkEnded } from "../utils/linkEnded";
import {
  appendOutbox,
  cancelOutbox,
  clearOutbox,
  loadOutbox,
  loadReturnedPosts,
  markOutboxAttempt,
  type OutboxRow,
  outboxViewOf,
  removeOutbox,
  removeOutboxWithReplies,
  removeReturned,
  restoreOutbox,
  returnOutboxRow,
  serverIdOf,
  setOutboxSending,
  slotOf,
  subscribeOutbox,
  waitingSlot,
} from "./outboxStore";

const hex = (n: number) => n.toString(16).padStart(32, "0");

const comment = (n: number, at = n): OutboxRow => ({
  id: hex(n),
  kind: "comment",
  body: `note ${n}`,
  author: "Ana",
  created_at: at,
  anchor: {
    timeline_start: 12,
    timeline_end: null,
    timeline_spans: null,
    track_ids: [],
    edit_decision_id: null,
  },
});

const reply = (n: number, parent: string): OutboxRow => ({
  id: hex(n),
  kind: "reply",
  body: `reply ${n}`,
  author: "Ana",
  created_at: n,
  parent_comment_id: parent,
});

const rows = new Map<string, unknown>();

beforeEach(() => {
  rows.clear();
  stubIndexedDb(rows);
});
afterEach(() => vi.unstubAllGlobals());

describe("the outbox", () => {
  it("keeps rows in the order they were written and survives a reload", async () => {
    await appendOutbox("tok", comment(1));
    await appendOutbox("tok", reply(2, "host-comment"));
    await appendOutbox("tok", comment(3));
    expect((await loadOutbox("tok")).map((r) => r.id)).toEqual([
      hex(1),
      hex(2),
      hex(3),
    ]);
    expect(rows.has("outbox:tok")).toBe(true);
    expect(await loadOutbox("other")).toEqual([]);
  });

  it("keeps one row for a key it already holds", async () => {
    await appendOutbox("tok", comment(1));
    await appendOutbox("tok", { ...comment(1), body: "changed" });
    const stored = await loadOutbox("tok");
    expect(stored).toHaveLength(1);
    expect(stored[0].body).toBe("note 1");
  });

  it("hands back a removed row and puts it back where its time says", async () => {
    await appendOutbox("tok", comment(1, 10));
    await appendOutbox("tok", comment(2, 20));
    await appendOutbox("tok", comment(3, 30));
    const removed = await removeOutbox("tok", hex(2));
    expect(removed?.body).toBe("note 2");
    expect(await removeOutbox("tok", hex(2))).toBeNull();
    await restoreOutbox("tok", removed as OutboxRow);
    expect((await loadOutbox("tok")).map((r) => r.id)).toEqual([
      hex(1),
      hex(2),
      hex(3),
    ]);
  });

  it("moves a refused row to the returned list with its reason", async () => {
    await appendOutbox("tok", comment(1));
    await appendOutbox("tok", comment(2));
    await returnOutboxRow(
      "tok",
      hex(1),
      "This link no longer allows comments.",
      403,
    );
    expect((await loadOutbox("tok")).map((r) => r.id)).toEqual([hex(2)]);
    const [returned] = await loadReturnedPosts("tok");
    expect(returned).toMatchObject({
      id: hex(1),
      body: "note 1",
      reason: "This link no longer allows comments.",
      status: 403,
    });
    expect((await removeReturned("tok", hex(1)))?.body).toBe("note 1");
    expect(await loadReturnedPosts("tok")).toEqual([]);
  });

  it("refuses to keep a row that is not a comment or reply, and a saved list that is not a list", async () => {
    await expect(
      appendOutbox("tok", { id: "short", kind: "comment" } as never),
    ).rejects.toThrow("Invalid saved comment");
    await expect(
      appendOutbox("tok", { ...reply(1, "x"), parent_comment_id: "" }),
    ).rejects.toThrow("Invalid saved reply");
    rows.set("outbox:tok", { not: "a list" });
    await expect(loadOutbox("tok")).rejects.toThrow(
      "Invalid saved comment list",
    );
  });
});

describe("a comment's id from waiting to posted", () => {
  it("is the same slot whether the server has named it or not", () => {
    const key = hex(7);
    expect(slotOf(`g-abc123-${key}`)).toBe(waitingSlot(key));
    expect(slotOf(waitingSlot(key))).toBe(waitingSlot(key));
    expect(slotOf("host-comment")).toBe("host-comment");
  });

  it("finds the server's id once the comment is in the project", () => {
    const key = hex(7);
    const listed = [{ id: "host-comment" }, { id: `g-abc123-${key}` }];
    expect(serverIdOf(waitingSlot(key), listed)).toBe(`g-abc123-${key}`);
    expect(serverIdOf(waitingSlot(key), [{ id: "host-comment" }])).toBeNull();
    expect(serverIdOf("host-comment", [])).toBe("host-comment");
  });
});

describe("the view a tab shows", () => {
  it("follows the store and the row being sent", async () => {
    const seen = vi.fn();
    const stop = subscribeOutbox("tok", seen);
    await vi.waitFor(() => expect(outboxViewOf("tok").loaded).toBe(true));
    await appendOutbox("tok", comment(1));
    expect(outboxViewOf("tok").rows.map((r) => r.id)).toEqual([hex(1)]);
    setOutboxSending("tok", hex(1), true);
    expect(outboxViewOf("tok").sending.has(hex(1))).toBe(true);
    setOutboxSending("tok", hex(1), false);
    expect(outboxViewOf("tok").sending.size).toBe(0);
    stop();
    expect(outboxViewOf("tok").loaded).toBe(false);
  });
});

describe("a comment taken out with Don't send", () => {
  it("serializes removal and sending in browsers without Web Locks", async () => {
    vi.stubGlobal("navigator", {});
    await appendOutbox("tok", comment(1));
    expect(await markOutboxAttempt("tok", hex(1))).toBe(true);
    expect(await cancelOutbox("tok", hex(1))).toBeNull();
    expect(await loadOutbox("tok")).toMatchObject([
      { id: hex(1), attempted: true },
    ]);

    await appendOutbox("tok", comment(2));
    expect(await cancelOutbox("tok", hex(2))).toMatchObject([{ id: hex(2) }]);
    expect(await markOutboxAttempt("tok", hex(2))).toBe(false);
  });

  it("takes its waiting replies with it, by the kept id or the server id, and nothing else", async () => {
    await appendOutbox("tok", comment(1));
    await appendOutbox("tok", reply(2, `g-${hex(1)}`));
    await appendOutbox("tok", reply(3, `g-abc-${hex(1)}`));
    await appendOutbox("tok", reply(4, "host-comment"));
    await appendOutbox("tok", comment(5));
    const removed = await removeOutboxWithReplies("tok", hex(1));
    expect(removed?.map((r) => r.id)).toEqual([hex(1), hex(2), hex(3)]);
    expect((await loadOutbox("tok")).map((r) => r.id)).toEqual([
      hex(4),
      hex(5),
    ]);
  });
});

describe("a saved list with one bad row", () => {
  it("drops that row and reads the rest", async () => {
    rows.set("outbox:tok", [comment(1), { id: "nope" }, comment(3)]);
    rows.set("outbox-returned:tok", [
      { ...comment(4), reason: "No", status: 403 },
      { ...comment(5), reason: 7, status: null },
    ]);
    expect((await loadOutbox("tok")).map((r) => r.id)).toEqual([
      hex(1),
      hex(3),
    ]);
    expect((await loadReturnedPosts("tok")).map((r) => r.id)).toEqual([hex(4)]);
  });
});

describe("a link that ended", () => {
  it("does not re-create a retired outbox when a late post tries to keep its text", async () => {
    const token = "revoked-after-post-started";
    markLinkEnded(token);
    await clearOutbox(token);
    expect(await appendOutbox(token, comment(1))).toBe(false);
    expect(rows.has(`outbox:${token}`)).toBe(false);
  });

  it("forgets its waiting and returned posts and no other link's", async () => {
    await appendOutbox("tok", comment(1));
    await appendOutbox("tok", comment(2));
    await returnOutboxRow("tok", hex(2), "No", 403);
    await appendOutbox("other", comment(3));
    await clearOutbox("tok");
    expect(rows.has("outbox:tok")).toBe(false);
    expect(rows.has("outbox-returned:tok")).toBe(false);
    expect((await loadOutbox("other")).map((r) => r.id)).toEqual([hex(3)]);
  });
});
