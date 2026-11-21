import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { stubIndexedDb } from "../../test/fakeIndexedDb";
import { sampleComment } from "../../test/fixtures";
import { ApiError } from "../../utils/apiError";
import { markLinkEnded } from "../../utils/linkEnded";
import { drainOutbox, refusalReasonOf } from "./drainOutbox";
import {
  appendOutbox,
  loadOutbox,
  loadReturnedPosts,
  type OutboxRow,
} from "./outboxStore";

const send = vi.hoisted(() => vi.fn());
vi.mock("../../api", () => ({ sendGuestPost: send }));

const hex = (n: number) => n.toString(16).padStart(32, "0");
const comment = (n: number): OutboxRow => ({
  id: hex(n),
  kind: "comment",
  body: `note ${n}`,
  author: "Ana",
  created_at: n,
  anchor: {
    timeline_start: n,
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
const sent = { status: "sent", comment: null } as const;
const later = {
  status: "retry",
  error: new Error("no answer"),
  keep: true,
} as const;
const refused = (code: number, message = "No") =>
  ({
    status: "refused",
    code,
    error: new ApiError(message, null, code),
  }) as const;

const rows = new Map<string, unknown>();
const ids = async () => (await loadOutbox("tok")).map((r) => r.id);

beforeEach(() => {
  rows.clear();
  send.mockReset();
  stubIndexedDb(rows);
  useDawStore.setState({ project: null });
});
afterEach(() => vi.unstubAllGlobals());

describe("drainOutbox", () => {
  it("sends kept rows in the order they were written and clears each as it lands", async () => {
    for (const n of [1, 2, 3]) await appendOutbox("tok", comment(n));
    send.mockResolvedValue(sent);
    await drainOutbox("tok");
    expect(send.mock.calls.map(([, row]) => row.id)).toEqual([
      hex(1),
      hex(2),
      hex(3),
    ]);
    expect(await ids()).toEqual([]);
  });

  it("stops at the first row the host does not answer and keeps everything behind it", async () => {
    for (const n of [1, 2, 3]) await appendOutbox("tok", comment(n));
    send.mockResolvedValueOnce(sent).mockResolvedValueOnce(later);
    await drainOutbox("tok");
    expect(send).toHaveBeenCalledTimes(2);
    expect(await ids()).toEqual([hex(2), hex(3)]);
  });

  it("sends a row that timed out again under the same key", async () => {
    await appendOutbox("tok", comment(1));
    send.mockResolvedValueOnce(later).mockResolvedValueOnce(sent);
    await drainOutbox("tok");
    await drainOutbox("tok");
    expect(send.mock.calls.map(([, row]) => row.id)).toEqual([hex(1), hex(1)]);
    expect(await ids()).toEqual([]);
  });

  it("hands a refused row back with the reason and goes on to the next", async () => {
    await appendOutbox("tok", comment(1));
    await appendOutbox("tok", comment(2));
    send.mockResolvedValueOnce(refused(403)).mockResolvedValueOnce(sent);
    await drainOutbox("tok");
    expect(await ids()).toEqual([]);
    expect(await loadReturnedPosts("tok")).toMatchObject([
      {
        id: hex(1),
        body: "note 1",
        status: 403,
        reason: "This link no longer allows comments.",
      },
    ]);
  });

  it("hands back a reply whose comment was not posted without sending it", async () => {
    await appendOutbox("tok", comment(1));
    await appendOutbox("tok", reply(2, `g-${hex(1)}`));
    send.mockResolvedValueOnce(refused(422));
    await drainOutbox("tok");
    expect(send).toHaveBeenCalledTimes(1);
    expect(await loadReturnedPosts("tok")).toMatchObject([
      { id: hex(1) },
      {
        id: hex(2),
        reason: "The comment it answers was not posted.",
        status: null,
      },
    ]);
  });

  it("sends a reply to a kept comment to the id the server gave that comment", async () => {
    await appendOutbox("tok", comment(1));
    await appendOutbox("tok", reply(2, `g-${hex(1)}`));
    send.mockImplementation(async (_token, row) => {
      if (row.kind === "comment") {
        useDawStore.setState({
          project: {
            comments: [sampleComment({ id: `g-abc-${hex(1)}` })],
          } as never,
        });
      }
      return sent;
    });
    await drainOutbox("tok");
    expect(send.mock.calls[1][2]).toBe(`g-abc-${hex(1)}`);
    expect(await ids()).toEqual([]);
  });

  it("leaves a reply whose comment it cannot find, and sends the rest", async () => {
    await appendOutbox("tok", reply(1, `g-${hex(9)}`));
    await appendOutbox("tok", comment(2));
    send.mockResolvedValue(sent);
    await drainOutbox("tok");
    expect(send).toHaveBeenCalledTimes(1);
    expect(await ids()).toEqual([hex(1)]);
  });

  it("sends nothing for a link that ended", async () => {
    await appendOutbox("tok", comment(1));
    markLinkEnded("tok");
    await drainOutbox("tok");
    expect(send).not.toHaveBeenCalled();
    expect(await ids()).toEqual([hex(1)]);
  });

  it("leaves the pass to the tab that holds the lock", async () => {
    await appendOutbox("tok", comment(1));
    const request = vi.fn(async (_name, _opts, run) => run(null));
    vi.stubGlobal("navigator", { ...navigator, locks: { request } });
    await drainOutbox("tok");
    expect(request).toHaveBeenCalledWith(
      "sharecut-outbox:tok",
      { ifAvailable: true },
      expect.any(Function),
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe("refusalReasonOf", () => {
  const long = { kind: "comment", body: "x".repeat(8001) } as const;
  it("says what the host refused in words for the writer", () => {
    expect(refusalReasonOf(long, 422, new Error("x"))).toBe(
      "It's longer than 8,000 characters. Shorten it and send again.",
    );
    expect(
      refusalReasonOf({ kind: "reply", body: "a" }, 403, new Error("x")),
    ).toBe("This link no longer allows replies.");
    expect(
      refusalReasonOf(
        { kind: "comment", body: "a" },
        409,
        new Error("It is gone."),
      ),
    ).toBe("It is gone.");
  });
});
