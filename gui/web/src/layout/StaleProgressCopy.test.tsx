import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaleProgressCopy } from "./StaleProgressCopy";

describe("StaleProgressCopy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks lag copy without putting it in a parent live region", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
    const t0 = Date.now() / 1000;
    render(
      <div>
        <div role="status">headline</div>
        <StaleProgressCopy lastProgressAt={t0} running announce />
      </div>,
    );
    expect(screen.queryByText(/last update/)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    expect(screen.getByText("last update 16s ago")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("headline");
    expect(screen.getByText("Progress stalled")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("last update 17s ago")).toBeTruthy();
    expect(screen.getByRole("status").textContent).not.toContain("last update");
  });
});
