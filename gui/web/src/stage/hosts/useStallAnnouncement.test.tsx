import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  PROGRESS_RESUMED,
  PROGRESS_STALLED,
  useStallAnnouncement,
} from "./useStallAnnouncement";

type U = { at: number | null; running?: boolean; tracked?: boolean };
type Props = { us: U[]; now: number };

function setup(us: U[], now: number) {
  const announce = vi.fn();
  const hook = renderHook(
    ({ us: list, now: n }: Props) =>
      useStallAnnouncement(
        list.map((u) => ({
          running: u.running ?? true,
          tracked: u.tracked ?? true,
          lastProgressAt: u.at,
        })),
        n,
        announce,
      ),
    { initialProps: { us, now } },
  );
  return { announce, rerender: hook.rerender };
}

describe("useStallAnnouncement", () => {
  it("stays silent on mount, fresh or already stale", () => {
    expect(setup([{ at: 100 }], 105).announce).not.toHaveBeenCalled();
    expect(setup([{ at: 100 }], 200).announce).not.toHaveBeenCalled();
  });

  it("announces once when stale, again only on resume", () => {
    const { announce, rerender } = setup([{ at: 100 }], 105);
    rerender({ us: [{ at: 100 }], now: 116 });
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith(PROGRESS_STALLED);
    rerender({ us: [{ at: 100 }], now: 117 });
    rerender({ us: [{ at: 100 }], now: 130 });
    expect(announce).toHaveBeenCalledTimes(1);
    rerender({ us: [{ at: 129 }], now: 131 });
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenLastCalledWith(PROGRESS_RESUMED);
    rerender({ us: [{ at: 129 }], now: 140 });
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("resets silently when a stalled job ends", () => {
    const { announce, rerender } = setup([{ at: 100 }], 105);
    rerender({ us: [{ at: 100 }], now: 116 });
    rerender({ us: [{ at: 100, running: false }], now: 117 });
    expect(announce).toHaveBeenCalledTimes(1);
    rerender({ us: [{ at: 120 }], now: 121 });
    expect(announce).toHaveBeenCalledTimes(1);
    rerender({ us: [{ at: 120 }], now: 140 });
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenLastCalledWith(PROGRESS_STALLED);
  });

  it("ignores a job with no progress timestamp", () => {
    const { announce, rerender } = setup([{ at: null }], 10);
    rerender({ us: [{ at: null }], now: 500 });
    expect(announce).not.toHaveBeenCalled();
  });

  it("speaks once for an export and a bounce stalling together", () => {
    const { announce, rerender } = setup([{ at: 100 }, { at: 100 }], 105);
    rerender({ us: [{ at: 100 }, { at: 100 }], now: 120 });
    expect(announce).toHaveBeenCalledTimes(1);
    rerender({ us: [{ at: 119 }, { at: 100 }], now: 121 });
    expect(announce).toHaveBeenCalledTimes(1);
    rerender({ us: [{ at: 119 }, { at: 120 }], now: 122 });
    expect(announce).toHaveBeenLastCalledWith(PROGRESS_RESUMED);
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when the stalled export ends while the bounce is fresh", () => {
    const { announce, rerender } = setup([{ at: 100 }, { at: 115 }], 110);
    rerender({ us: [{ at: 100 }, { at: 115 }], now: 120 });
    expect(announce).toHaveBeenCalledTimes(1);
    rerender({ us: [{ at: 100, running: false }, { at: 119 }], now: 121 });
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("speaks each transition of a flapping heartbeat", () => {
    const { announce, rerender } = setup([{ at: 100 }], 110);
    rerender({ us: [{ at: 100 }], now: 116 });
    rerender({ us: [{ at: 116 }], now: 117 });
    rerender({ us: [{ at: 116 }], now: 132 });
    expect(announce.mock.calls.map((c) => c[0])).toEqual([
      PROGRESS_STALLED,
      PROGRESS_RESUMED,
      PROGRESS_STALLED,
    ]);
  });

  it("makes no announcement while another job holds the activity slot", () => {
    const { announce, rerender } = setup([{ at: 100 }], 110);
    rerender({ us: [{ at: 100 }], now: 116 });
    rerender({ us: [{ at: undefined as never, tracked: false }], now: 120 });
    expect(announce).toHaveBeenCalledTimes(1);
    rerender({ us: [{ at: 100 }], now: 125 });
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("stays silent for a run that was never fresh (clock skew)", () => {
    const { announce, rerender } = setup([{ at: 100 }], 200);
    rerender({ us: [{ at: 100 }], now: 201 });
    rerender({ us: [{ at: 100 }], now: 300 });
    expect(announce).not.toHaveBeenCalled();
    rerender({ us: [{ at: 299 }], now: 301 });
    expect(announce).not.toHaveBeenCalled();
  });

  it("stays silent for a run that starts stale, then speaks once it was fresh", () => {
    const { announce, rerender } = setup([{ at: 100, running: false }], 200);
    rerender({ us: [{ at: 100 }], now: 201 });
    expect(announce).not.toHaveBeenCalled();
    rerender({ us: [{ at: 200 }], now: 202 });
    rerender({ us: [{ at: 200 }], now: 220 });
    expect(announce).toHaveBeenLastCalledWith(PROGRESS_STALLED);
  });

  it("does not speak resumed without a spoken stall", () => {
    const { announce, rerender } = setup([{ at: 100 }], 200);
    rerender({ us: [{ at: 199 }], now: 201 });
    expect(announce).not.toHaveBeenCalled();
  });

  it("speaks stall then resume", () => {
    const { announce, rerender } = setup([{ at: 100 }], 105);
    rerender({ us: [{ at: 100 }], now: 130 });
    rerender({ us: [{ at: 129 }], now: 131 });
    expect(announce.mock.calls.map((c) => c[0])).toEqual([
      PROGRESS_STALLED,
      PROGRESS_RESUMED,
    ]);
  });

  it("speaks resumed once when the slot returns fresh after a spoken stall", () => {
    const { announce, rerender } = setup([{ at: 100 }], 110);
    rerender({ us: [{ at: 100 }], now: 116 });
    rerender({ us: [{ at: undefined as never, tracked: false }], now: 120 });
    rerender({ us: [{ at: 124 }], now: 125 });
    rerender({ us: [{ at: 125 }], now: 126 });
    expect(announce.mock.calls.map((c) => c[0])).toEqual([
      PROGRESS_STALLED,
      PROGRESS_RESUMED,
    ]);
  });

  it("treats a run that is not running as silent (cancelling is passed as not running)", () => {
    const { announce, rerender } = setup([{ at: 100 }], 105);
    rerender({ us: [{ at: 100, running: false }], now: 130 });
    expect(announce).not.toHaveBeenCalled();
  });
});
