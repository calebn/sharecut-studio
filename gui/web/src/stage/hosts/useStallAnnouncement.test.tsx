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
    rerender({ us: [{ at: 100 }], now: 130 });
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
});
