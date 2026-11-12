import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockStorage } from "../test/blockStorage";
import { createMonotonicSeq, nextSeq } from "./monotonicSeq";

const key = "test_seq";
const now = 1_700_000_000_000;

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createMonotonicSeq counter admission", () => {
  it.each([
    [null, 1],
    ["0", 1],
    ["41", 42],
    ["00041", 42],
    ["9007199254740989", 9007199254740990],
  ] as const)("advances the complete valid counter %s to %s", (raw, next) => {
    if (raw !== null) sessionStorage.setItem(key, raw);
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(createMonotonicSeq(key, { onCorrupt: "throw" }).next()).toBe(next);
    expect(write).toHaveBeenCalledExactlyOnceWith(key, String(next));
    expect(sessionStorage.getItem(key)).toBe(String(next));
  });

  it.each([
    "",
    " ",
    "NaN",
    "41tail",
    "1.5",
    "1e2",
    "-1",
    "Infinity",
    "9007199254740992",
    "9007199254740991",
    "9007199254740990",
  ])("throws on counter %j before changing its raw value", (raw) => {
    sessionStorage.setItem(key, raw);
    const seq = createMonotonicSeq(key, { onCorrupt: "throw" });
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(() => seq.next()).toThrow(
      "Cannot create this edit because its saved sequence is invalid.",
    );
    expect(sessionStorage.getItem(key)).toBe(raw);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("createMonotonicSeq floor", () => {
  it("never decreases when storage is rewound", () => {
    const seq = createMonotonicSeq(key, { onCorrupt: "reset" });
    expect(seq.next()).toBe(1);
    expect(seq.next()).toBe(2);
    sessionStorage.setItem(key, "0");
    expect(seq.next()).toBe(3);
    sessionStorage.removeItem(key);
    expect(seq.next()).toBe(4);
  });

  it("follows a stored value that is ahead of memory", () => {
    const seq = createMonotonicSeq(key, { onCorrupt: "reset" });
    expect(seq.next()).toBe(1);
    sessionStorage.setItem(key, "50");
    expect(seq.next()).toBe(51);
  });

  it("isolates counters by key", () => {
    const a = createMonotonicSeq("a", { onCorrupt: "reset" });
    const b = createMonotonicSeq("b", { onCorrupt: "reset" });
    expect([a.next(), a.next(), b.next()]).toEqual([1, 2, 1]);
    expect(sessionStorage.getItem("a")).toBe("2");
    expect(sessionStorage.getItem("b")).toBe("1");
  });
});

describe("createMonotonicSeq corrupt reset", () => {
  it("restarts above the clock seed, never at 1", () => {
    vi.useFakeTimers({ now });
    sessionStorage.setItem(key, "41tail");
    const seq = createMonotonicSeq(key, { onCorrupt: "reset" });
    expect(seq.next()).toBe(now + 1);
    expect(sessionStorage.getItem(key)).toBe(String(now + 1));
    expect(seq.next()).toBe(now + 2);
  });

  it("keeps a floor above the clock seed", () => {
    const seq = createMonotonicSeq(key, { onCorrupt: "reset" });
    sessionStorage.setItem(key, String(now * 2));
    expect(seq.next()).toBe(now * 2 + 1);
    sessionStorage.setItem(key, "x");
    vi.useFakeTimers({ now });
    expect(seq.next()).toBe(now * 2 + 2);
  });
});

describe("createMonotonicSeq upper bound", () => {
  it("restarts from the clock instead of writing MAX_SAFE_INTEGER", () => {
    vi.useFakeTimers({ now });
    sessionStorage.setItem(key, "9007199254740990");
    const seq = createMonotonicSeq(key, { onCorrupt: "reset" });
    expect(seq.next()).toBe(now + 1);
    expect(sessionStorage.getItem(key)).toBe(String(now + 1));
  });
});

describe("createMonotonicSeq blocked storage", () => {
  it("does not throw, repeat or decrease, and starts at the clock", () => {
    vi.useFakeTimers({ now });
    blockStorage();
    const seq = createMonotonicSeq(key, { onCorrupt: "throw" });
    const values = [seq.next(), seq.next(), seq.next()];
    expect(values).toEqual([now + 1, now + 2, now + 3]);
    vi.setSystemTime(now - 5000);
    expect(seq.next()).toBe(now + 4);
  });

  it("reloaded counter resumes from storage while issued values stay above it", () => {
    vi.useFakeTimers({ now });
    sessionStorage.setItem(key, "7");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const first = createMonotonicSeq(key, { onCorrupt: "throw" });
    const issued = [first.next(), first.next()];
    expect(issued[0]).toBeGreaterThan(now);
    expect(issued[1]).toBeGreaterThan(issued[0]);
    vi.restoreAllMocks();
    const reloaded = createMonotonicSeq(key, { onCorrupt: "throw" });
    const afterReload = reloaded.next();
    expect(afterReload).toBe(8);
    expect(afterReload).toBeLessThan(issued[0]);
  });
});

describe("nextSeq", () => {
  it("keeps one floor per key across calls", () => {
    expect([nextSeq("n1"), nextSeq("n1")]).toEqual([1, 2]);
    sessionStorage.setItem("n1", "0");
    expect(nextSeq("n1")).toBe(3);
    expect(nextSeq("n2")).toBe(1);
  });
});
