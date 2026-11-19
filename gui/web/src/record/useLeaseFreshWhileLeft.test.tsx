import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRecordParticipant } from "../services/offlineQueue/offlineStore";
import { useLeaseFreshWhileLeft } from "./useLeaseFreshWhileLeft";

vi.mock("../services/offlineQueue/offlineStore", () => ({
  loadRecordParticipant: vi.fn(),
}));

const DAY = 24 * 60 * 60 * 1000;

function cache(issuedAt: number | undefined) {
  vi.mocked(loadRecordParticipant).mockResolvedValue({
    participant_id: "p_g",
    lease: "l",
    ...(issuedAt === undefined ? {} : { issuedAt }),
  });
}

async function leave(issuedAt: number | undefined) {
  cache(issuedAt);
  const hook = renderHook(({ left }) => useLeaseFreshWhileLeft("tok", left), {
    initialProps: { left: false },
  });
  await act(async () => {
    hook.rerender({ left: true });
  });
  return hook;
}

describe("useLeaseFreshWhileLeft", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides the offer once a page left at day 5.9 stays open past day 6", async () => {
    const { result } = await leave(Date.now() - 5.9 * DAY);
    expect(result.current.leaseFresh).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0.1 * DAY - 1000);
    });
    expect(result.current.leaseFresh).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.leaseFresh).toBe(false);
  });

  it("keeps the offer at exactly six days and drops it a moment later", async () => {
    const { result } = await leave(Date.now() - 6 * DAY + 100);
    expect(result.current.leaseFresh).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.leaseFresh).toBe(true);
    expect(result.current.leaseStillFresh()).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(result.current.leaseFresh).toBe(false);
    expect(result.current.leaseStillFresh()).toBe(false);
  });

  it("answers false at press time when the clock passed the limit before the timer ran", async () => {
    const { result } = await leave(Date.now() - 5 * DAY);
    expect(result.current.leaseStillFresh()).toBe(true);
    vi.setSystemTime(Date.now() + 1.5 * DAY);
    expect(result.current.leaseStillFresh()).toBe(false);
  });

  it("is never fresh with no stamp, and resets when the page is no longer left", async () => {
    const none = await leave(undefined);
    expect(none.result.current.leaseFresh).toBe(false);
    expect(none.result.current.leaseStillFresh()).toBe(false);
    const { result, rerender } = await leave(Date.now() - DAY);
    expect(result.current.leaseFresh).toBe(true);
    await act(async () => {
      rerender({ left: false });
    });
    expect(result.current.leaseFresh).toBe(false);
    expect(result.current.leaseStillFresh()).toBe(false);
  });
});
