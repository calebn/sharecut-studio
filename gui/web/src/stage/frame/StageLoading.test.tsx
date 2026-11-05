import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { StageLoading } from "./StageLoading";

describe("StageLoading", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("draws nothing for 300 ms, then the Stage bar and grey blocks, never a spinner", () => {
    const { container } = render(
      <StageLoading
        stage="review"
        name="Rosa and Maya"
        shell="desktop"
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(container.querySelector(".sys-skeleton-block")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(
      screen.getByRole("tab", { name: "Review", selected: true }),
    ).toBeInTheDocument();
    expect(screen.getByText("Rosa and Maya")).toBeInTheDocument();
    expect(
      container.querySelectorAll(
        ".stage-loading-body--review .sys-skeleton-block",
      ),
    ).toHaveLength(5);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(
      screen.queryAllByText(/Loading/).filter((el) => !el.matches(".sr-only")),
    ).toHaveLength(0);
    expect(screen.queryByText("Still loading.")).toBeNull();
  });

  it("keeps the Stage bar inert and announces the wait only after the blank", () => {
    const { container } = render(
      <StageLoading stage="review" shell="desktop" onRetry={vi.fn()} />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Loading the project");
    const stages = container.querySelector(".stage-loading-stages");
    expect(stages).toHaveAttribute("inert");
    expect(stages?.querySelector(".sys-stage-tab")).not.toBeNull();
  });

  it("leaves the status outside any aria-busy region so it is announced", () => {
    render(
      <StageLoading
        stage="review"
        shell="desktop"
        elapsedMs={9000}
        onRetry={vi.fn()}
      />,
    );
    for (const status of screen.getAllByRole("status")) {
      expect(status.closest('[aria-busy="true"]')).toBeNull();
    }
  });

  it("lays the blocks out like the destination stage", () => {
    const { container } = render(
      <StageLoading
        stage="edit"
        shell="desktop"
        elapsedMs={500}
        onRetry={vi.fn()}
      />,
    );
    expect(
      container.querySelectorAll(".stage-loading-block--lane"),
    ).toHaveLength(3);
  });

  it("puts the Stage bar in the tab bar on a phone", () => {
    const { container } = render(
      <StageLoading
        stage="prepare"
        shell="phone"
        elapsedMs={500}
        onRetry={vi.fn()}
      />,
    );
    expect(
      container.querySelector(".stage-frame-tabs .sys-stage-bar--tabs"),
    ).not.toBeNull();
    expect(
      container.querySelector(".stage-frame-header .sys-stage-bar"),
    ).toBeNull();
  });

  it("offers Try again after 8 s", () => {
    const onRetry = vi.fn();
    render(<StageLoading stage="prepare" shell="desktop" onRetry={onRetry} />);
    act(() => {
      vi.advanceTimersByTime(7999);
    });
    expect(screen.queryByText("Still loading.")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("Still loading.")).toBeInTheDocument();
    screen.getByRole("button", { name: "Try again" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("is axe-clean", async () => {
    vi.useRealTimers();
    const { container } = render(
      <StageLoading
        stage="deliver"
        shell="desktop"
        elapsedMs={9000}
        onRetry={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
