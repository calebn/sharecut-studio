import { describe, expect, it } from "vitest";
import { sampleComment } from "../test/fixtures";
import { applyCommentsFrame } from "./commentsReplica";

const revision = "a".repeat(32);
const newer = "b".repeat(32);
describe("light comments replica", () => {
  it("applies exact predecessor rows without mutating the snapshot", () => {
    const before = applyCommentsFrame(
      { kind: "awaiting" },
      {
        plane: "comments",
        type: "Snapshot",
        revision,
        comments: [sampleComment({ body: "Before" })],
      },
    );
    const after = applyCommentsFrame(before, {
      plane: "comments",
      type: "Applied",
      previous_revision: revision,
      revision: newer,
      operations: {
        before_count: 1,
        splices: [],
        updates: [{ index: 0, value: sampleComment({ body: "After" }) }],
      },
    });
    expect(after).toMatchObject({
      kind: "ready",
      revision: newer,
      comments: [{ body: "After" }],
    });
    expect(before).toMatchObject({ comments: [{ body: "Before" }] });
  });
  it("rejects an unknown basis and malformed comments", () => {
    expect(() =>
      applyCommentsFrame(
        { kind: "awaiting" },
        {
          plane: "comments",
          type: "Applied",
          revision: newer,
          previous_revision: revision,
          operations: {},
        },
      ),
    ).toThrow();
    expect(() =>
      applyCommentsFrame(
        { kind: "awaiting" },
        {
          plane: "comments",
          type: "Snapshot",
          revision,
          comments: [{ id: "bad" }],
        },
      ),
    ).toThrow();
  });
});
