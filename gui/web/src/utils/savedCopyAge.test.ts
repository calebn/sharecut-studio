import { describe, expect, it } from "vitest";
import { isSavedCopyFresh, SAVED_COPY_MAX_AGE_MS } from "./savedCopyAge";

describe("saved-copy freshness", () => {
  const now = 2 * SAVED_COPY_MAX_AGE_MS;
  it("permits reopening before seven days and refuses it at the boundary", () => {
    expect(isSavedCopyFresh(now - SAVED_COPY_MAX_AGE_MS + 1, now)).toBe(true);
    expect(isSavedCopyFresh(now - SAVED_COPY_MAX_AGE_MS, now)).toBe(false);
    expect(isSavedCopyFresh(now - SAVED_COPY_MAX_AGE_MS - 1, now)).toBe(false);
  });

  it("requires a valid time from the past or present", () => {
    expect(isSavedCopyFresh(now, now)).toBe(true);
    for (const time of [undefined, 0, -1, NaN, Infinity, now + 1]) {
      expect(isSavedCopyFresh(time, now)).toBe(false);
    }
  });
});
