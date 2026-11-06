import { readFileSync } from "node:fs";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PHONE_MQ } from "../../hooks/useViewportClass";
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

  it("gives Retry the touch-min target at every size and the status row the block gutter", () => {
    render(<GuestLoadingScreen onRetry={() => {}} />);
    act(() => void vi.advanceTimersByTime(4000));
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toHaveClass("sys-skeleton-retry");
    const css = readFileSync("src/styles/partials/system.css", "utf8");
    const rule = (selector: string) =>
      css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    // Unconditional: the rule is not inside a pointer: coarse query.
    expect(rule("\\.sys-skeleton-retry")).toContain(
      "min-block-size: var(--touch-min)",
    );
    const row = rule("\\.sys-skeleton--guest > \\.sys-skeleton-slow");
    expect(row).toContain("padding-inline: var(--space-5)");
    expect(row).not.toMatch(/\d+px/);
    // The header spans the columns; it no longer bleeds into the gutter.
    expect(
      rule("\\.sys-skeleton-blocks--guest \\.sys-skeleton-block--header"),
    ).not.toContain("margin-inline");
  });

  it("collapses the guest skeleton at the phone shell breakpoint", () => {
    const css = readFileSync("src/styles/partials/system.css", "utf8");
    const at = css.indexOf(
      ".sys-skeleton-blocks--guest {",
      css.indexOf("@media"),
    );
    const queries = [
      ...css.matchAll(
        /@media (\([^)]*\)) \{\s*\.sys-skeleton-blocks--guest \{/g,
      ),
    ];
    expect(queries.map((m) => m[1])).toContain(PHONE_MQ);
    expect(at).toBeGreaterThan(-1);
  });
});
