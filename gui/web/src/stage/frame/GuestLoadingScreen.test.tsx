import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { GuestLoadingScreen } from "./GuestLoadingScreen";

describe("GuestLoadingScreen", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("draws nothing for 300 ms, then the guest frame, then Retry at 4 s", async () => {
    const onRetry = vi.fn();
    const { container } = render(<GuestLoadingScreen onRetry={onRetry} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading project…");
    expect(container.querySelectorAll(".sys-skeleton-block")).toHaveLength(0);
    act(() => void vi.advanceTimersByTime(300));
    for (const part of ["header", "player", "queue", "center"])
      expect(
        container.querySelector(`.sys-skeleton-block--${part}`),
      ).not.toBeNull();
    expect(screen.queryByText("Still loading…")).toBeNull();
    act(() => void vi.advanceTimersByTime(3700));
    expect(screen.getByText("Still loading…")).toBeVisible();
    vi.useRealTimers();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });
});
