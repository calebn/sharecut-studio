import { afterEach, describe, expect, it, vi } from "vitest";
import { WaveformFetchError } from "../api";
import { useDawStore } from "../state/dawStore";
import {
  ByteLru,
  classifyFetchFailure,
  FetchGate,
  fetchLimit,
  WAVEFORM_BUDGETS,
  waveformBudget,
} from "./budgets";

describe("waveform budgets", () => {
  afterEach(() => {
    useDawStore.getState().setShellBreakpoint("desktop");
  });

  it("uses the phone budgets on the phone shell", () => {
    expect(waveformBudget()).toBe(WAVEFORM_BUDGETS.desktop);
    useDawStore.getState().setShellBreakpoint("phone");
    expect(waveformBudget()).toBe(WAVEFORM_BUDGETS.phone);
    expect(WAVEFORM_BUDGETS.phone.bitmapBytes).toBe(48 * 1024 * 1024);
  });

  it("allows 4 host fetches and 3 guest fetches", () => {
    expect(fetchLimit("/tmp/p.json")).toBe(4);
    expect(fetchLimit("share:tok")).toBe(3);
  });
});

describe("FetchGate", () => {
  it("caps slots and wakes waiters on release", () => {
    const gate = new FetchGate();
    const wake = vi.fn();
    const off = gate.onRelease(wake);
    expect(gate.tryAcquire(2)).toBe(true);
    expect(gate.tryAcquire(2)).toBe(true);
    expect(gate.tryAcquire(2)).toBe(false);
    gate.release();
    expect(wake).toHaveBeenCalledOnce();
    expect(gate.active).toBe(1);
    off();
    gate.release();
    gate.release();
    expect(wake).toHaveBeenCalledOnce();
    expect(gate.active).toBe(0);
  });
});

describe("ByteLru", () => {
  it("evicts least recently used values past the budget", () => {
    const evicted: string[] = [];
    const lru = new ByteLru<number>(
      () => 10,
      (key) => evicted.push(key),
    );
    lru.set("a", 1, 4);
    lru.set("b", 2, 4);
    expect(lru.get("a")).toBe(1);
    lru.set("c", 3, 4);
    expect(evicted).toEqual(["b"]);
    expect(lru.has("a")).toBe(true);
    expect(lru.bytes).toBe(8);
    expect([...lru.keys()]).toEqual(["a", "c"]);
    expect(lru.peek("a")).toBe(1);
    expect([...lru.entries()].map(([k]) => k)).toEqual(["a", "c"]);
    lru.set("a", 5, 2);
    expect(lru.bytes).toBe(6);
    lru.clear();
    expect(lru.size).toBe(0);
    expect(evicted).toEqual(["b", "a", "c", "a"]);
  });
});

describe("classifyFetchFailure", () => {
  it("retries 429 after Retry-After and names 404 and 409", () => {
    expect(classifyFetchFailure(new WaveformFetchError(429, 3))).toEqual({
      kind: "retry",
      afterMs: 3000,
    });
    expect(classifyFetchFailure(new WaveformFetchError(429, null))).toEqual({
      kind: "retry",
      afterMs: 1000,
    });
    expect(classifyFetchFailure(new WaveformFetchError(404, null)).kind).toBe(
      "missing",
    );
    expect(classifyFetchFailure(new WaveformFetchError(409, null)).kind).toBe(
      "stale",
    );
    expect(classifyFetchFailure(new WaveformFetchError(500, null)).kind).toBe(
      "drop",
    );
    expect(classifyFetchFailure(new Error("offline")).kind).toBe("drop");
  });
});
