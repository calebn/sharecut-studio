import { afterEach, describe, expect, it } from "vitest";
import {
  _resetOpenBundleQueueForTests,
  drainOpenBundleQueue,
  OPEN_BUNDLE_QUEUE_KEY,
} from "./openBundleQueue";

const A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const B = "1f8fad5b-d9cb-469f-a165-70867728950e";

function seed(...items: unknown[]) {
  (window as unknown as Record<string, unknown>)[OPEN_BUNDLE_QUEUE_KEY] = items;
}

afterEach(_resetOpenBundleQueueForTests);

describe("drainOpenBundleQueue", () => {
  it("returns nothing when no queue exists", () => {
    expect(drainOpenBundleQueue()).toEqual([]);
  });

  it("takes the items in order and empties the queue", () => {
    seed(
      { id: A, name: "a.sharecutseg", size: 10 },
      { id: B, name: "b.sharecutkit", size: 0 },
    );
    expect(drainOpenBundleQueue().map((item) => item.id)).toEqual([A, B]);
    expect(drainOpenBundleQueue()).toEqual([]);
    expect(
      (window as unknown as Record<string, unknown[]>)[OPEN_BUNDLE_QUEUE_KEY],
    ).toHaveLength(0);
  });

  it("drops malformed items", () => {
    seed(
      null,
      "text",
      { id: "nope", name: "a.zip", size: 1 },
      { id: A, name: "", size: 1 },
      { id: A, name: "a.zip", size: "1" },
      { id: A, name: "a.zip", size: Number.NaN },
      { id: A, name: "a.zip", size: -1 },
      { id: B, name: "ok.zip", size: 5 },
    );
    expect(drainOpenBundleQueue()).toEqual([
      { id: B, name: "ok.zip", size: 5 },
    ]);
  });

  it("hands each id out once, within a drain and across drains", () => {
    seed({ id: A, name: "a.zip", size: 1 }, { id: A, name: "a.zip", size: 1 });
    expect(drainOpenBundleQueue()).toHaveLength(1);
    seed({ id: A, name: "a.zip", size: 1 });
    expect(drainOpenBundleQueue()).toEqual([]);
  });
});
