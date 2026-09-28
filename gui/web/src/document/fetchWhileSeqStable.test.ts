import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentDocumentSeq,
  noteDocumentSeq,
  resetDocumentSeqForTests,
} from "./cursor";
import { fetchWhileSeqStable } from "./fetchWhileSeqStable";

beforeEach(resetDocumentSeqForTests);

describe("fetchWhileSeqStable", () => {
  it("resolves { value } from a single load when the seq does not move", async () => {
    const load = vi.fn(async () => "a");
    const result = await fetchWhileSeqStable(load);
    expect(result).toEqual({ value: "a" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("loads again when the seq moves during the first load", async () => {
    const load = vi
      .fn()
      .mockImplementationOnce(async () => {
        noteDocumentSeq(currentDocumentSeq() + 1);
        return "stale";
      })
      .mockImplementationOnce(async () => "fresh");
    const result = await fetchWhileSeqStable(load);
    expect(result).toEqual({ value: "fresh" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("resolves null after exactly `attempts` loads when the seq keeps moving", async () => {
    const load = vi.fn(async () => {
      noteDocumentSeq(currentDocumentSeq() + 1);
      return "racing";
    });
    const result = await fetchWhileSeqStable(load, { attempts: 3 });
    expect(result).toBeNull();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("resolves null without a second load once isCancelled is true, even though the seq moved", async () => {
    let cancelled = false;
    const load = vi.fn(async () => {
      noteDocumentSeq(currentDocumentSeq() + 1);
      cancelled = true;
      return "racing";
    });
    const result = await fetchWhileSeqStable(load, {
      isCancelled: () => cancelled,
    });
    expect(result).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  describe("delayMs", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not start the second load until the delay elapses", async () => {
      const load = vi
        .fn()
        .mockImplementationOnce(async () => {
          noteDocumentSeq(currentDocumentSeq() + 1);
          return "stale";
        })
        .mockImplementationOnce(async () => "fresh");
      const promise = fetchWhileSeqStable(load, { delayMs: 150 });
      await vi.advanceTimersByTimeAsync(0);
      expect(load).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(150);
      const result = await promise;
      expect(result).toEqual({ value: "fresh" });
      expect(load).toHaveBeenCalledTimes(2);
    });

    it("resolves null with no second load when isCancelled turns true during the delay", async () => {
      let cancelled = false;
      const load = vi.fn().mockImplementationOnce(async () => {
        noteDocumentSeq(currentDocumentSeq() + 1);
        cancelled = true;
        return "stale";
      });
      const promise = fetchWhileSeqStable(load, {
        delayMs: 150,
        isCancelled: () => cancelled,
      });
      await vi.advanceTimersByTimeAsync(150);
      const result = await promise;
      expect(result).toBeNull();
      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects with the same error when load rejects", async () => {
    const boom = new Error("boom");
    const load = vi.fn(async () => {
      throw boom;
    });
    await expect(fetchWhileSeqStable(load)).rejects.toBe(boom);
  });
});
