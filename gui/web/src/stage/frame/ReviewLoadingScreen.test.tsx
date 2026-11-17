import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { systemCss } from "../../test/systemCss";
import { ReviewLoadingScreen } from "./ReviewLoadingScreen";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const blocks = (container: HTMLElement) =>
  container.querySelectorAll(".sys-skeleton-block").length;
const bar = (container: HTMLElement) =>
  container.querySelector(".sys-app-header-host");

describe("ReviewLoadingScreen with a name", () => {
  it("draws the header with the name and Loading… from mount, and says Loading <name>… to a screen reader", () => {
    const { container } = render(<ReviewLoadingScreen name="Pilot episode" />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading Pilot episode…",
    );
    const host = bar(container) as HTMLElement;
    expect(host).not.toBeNull();
    const title = host.querySelector(".sys-header-title") as HTMLElement;
    expect(title).toHaveTextContent("Pilot episode");
    expect(title).toHaveAttribute("aria-hidden", "true");
    expect(title.closest(".sys-header-guest")).not.toBeNull();
    expect(host.querySelector(".sys-header-sub")).toHaveTextContent("Loading…");
    expect(host.querySelector(".sys-header-sub")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Pilot episode" }),
    ).toHaveClass("sr-only");
    expect(blocks(container)).toBe(0);
  });

  it("gives the name a dir of auto, so a right-to-left name reads from its own side", () => {
    const { container } = render(<ReviewLoadingScreen name="פרק ראשון" />);
    expect(container.querySelector(".sys-header-title")).toHaveAttribute(
      "dir",
      "auto",
    );
  });

  it("puts the body blocks in at 300 ms, without a grey header block, and Still loading… with Retry at 4 s", async () => {
    const onRetry = vi.fn();
    const { container } = render(
      <ReviewLoadingScreen name="Pilot episode" onRetry={onRetry} />,
    );
    advance(300);
    for (const part of ["player", "queue", "center"])
      expect(
        container.querySelector(`.sys-skeleton-block--${part}`),
      ).not.toBeNull();
    expect(container.querySelector(".sys-skeleton-block--header")).toBeNull();
    expect(screen.queryByText("Still loading…")).toBeNull();
    advance(3700);
    expect(screen.getByText("Still loading…")).toBeVisible();
    vi.useRealTimers();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("shows a name with markup characters as plain text", () => {
    const name = `A <B> & "C" '`;
    const { container } = render(<ReviewLoadingScreen name={name} />);
    expect(container.querySelector(".sys-header-title")?.textContent).toBe(
      name,
    );
    expect(container.querySelector("b")).toBeNull();
  });
});

describe("ReviewLoadingScreen without a name", () => {
  it("draws nothing for 300 ms, and says Loading the episode… to a screen reader", () => {
    const { container } = render(<ReviewLoadingScreen name={null} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading the episode…",
    );
    expect(bar(container)).toBeNull();
    expect(blocks(container)).toBe(0);
    expect(container.textContent).toBe("EpisodeLoading the episode…");
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("sr-only");
  });

  it("then draws the header bar with one grey title block and no visible words", async () => {
    const { container } = render(<ReviewLoadingScreen name={null} />);
    advance(300);
    const host = bar(container) as HTMLElement;
    expect(host).not.toBeNull();
    expect(host.querySelector(".sys-header-title")).toBeNull();
    expect(host.querySelector(".sys-skeleton-block--title")).not.toBeNull();
    expect(host.querySelector(".sys-header-sub")?.textContent).toBe("");
    expect(container.querySelector(".sys-skeleton-block--header")).toBeNull();
    expect(
      container.querySelector(".sys-skeleton-block--player"),
    ).not.toBeNull();
    // Only the screen reader's status holds words.
    const visible = [...container.querySelectorAll("*")].filter(
      (el) =>
        !el.closest(".sr-only, [aria-hidden=true]") &&
        [...el.childNodes].some(
          (n) => n.nodeType === 3 && n.textContent?.trim(),
        ),
    );
    expect(visible).toEqual([]);
    vi.useRealTimers();
    await expectNoA11yViolations(container);
  });

  it("never says project, to anyone", () => {
    const { container } = render(<ReviewLoadingScreen name={null} />);
    advance(4000);
    expect(container.textContent?.toLowerCase()).not.toContain("project");
  });
});

describe("one loading clock across the Suspense swap", () => {
  it("keeps counting when a second screen takes over at 200 ms: blocks at 300 ms, Still loading… at 4 s", () => {
    const first = render(<ReviewLoadingScreen name="Pilot episode" />);
    advance(200);
    const second = render(<ReviewLoadingScreen name="Pilot episode" />);
    first.unmount();
    expect(blocks(second.container)).toBe(0);
    advance(100);
    expect(blocks(second.container)).toBeGreaterThan(0);
    advance(3699);
    expect(screen.queryByText("Still loading…")).toBeNull();
    advance(1);
    expect(screen.getByText("Still loading…")).toBeVisible();
  });

  it("opens the second screen with blocks, not blank, when the swap comes after 300 ms", () => {
    const first = render(<ReviewLoadingScreen name={null} />);
    advance(350);
    expect(blocks(first.container)).toBeGreaterThan(0);
    const second = render(<ReviewLoadingScreen name={null} />);
    first.unmount();
    expect(blocks(second.container)).toBeGreaterThan(0);
    expect(bar(second.container)).not.toBeNull();
  });

  it("starts fresh for a later screen, 600 ms after the last one left", () => {
    const first = render(<ReviewLoadingScreen name={null} />);
    advance(1000);
    first.unmount();
    advance(600);
    const later = render(<ReviewLoadingScreen name={null} />);
    expect(blocks(later.container)).toBe(0);
    expect(bar(later.container)).toBeNull();
  });
});

describe("the loading header's styles", () => {
  it("fixes the bar height with a rule that outranks the data-shell rule, 44 px when its container is narrow", () => {
    const css = systemCss();
    expect(css).toMatch(/\.sys-app-header--loading/);
    expect(css).toMatch(
      /\.sys-header-guest > \.sys-header-title \{[^}]*align-self: flex-start;[^}]*max-inline-size: 100%/,
    );
  });
});
