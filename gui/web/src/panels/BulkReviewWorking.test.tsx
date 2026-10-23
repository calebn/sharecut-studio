import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { BulkReviewWorking } from "./BulkReviewWorking";

describe("BulkReviewWorking", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-14T07:00:00Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const started = new Date("2026-10-14T07:00:00Z").getTime() / 1000;

  it("names the work and shows no clock while it is quick", () => {
    render(
      <BulkReviewWorking verb="Approving" count={86} startedAtSec={started} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      /^Approving 86 edits…$/,
    );
  });

  it("uses the singular for one edit", () => {
    render(
      <BulkReviewWorking verb="Rejecting" count={1} startedAtSec={started} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Rejecting 1 edit…");
  });

  it.each([1, 4])("names %i suggested actions as applying", (count) => {
    render(
      <BulkReviewWorking
        verb="Applying"
        count={count}
        startedAtSec={started}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      count === 1
        ? "Applying 1 suggested action…"
        : "Applying 4 suggested actions…",
    );
  });

  it("adds the elapsed time once it is not instant", () => {
    render(
      <BulkReviewWorking verb="Approving" count={86} startedAtSec={started} />,
    );
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      /^Approving 86 edits…$/,
    );
    expect(screen.getByText("0:12 so far.")).toBeVisible();
  });

  it("keeps the live region text still while the clock ticks", () => {
    render(
      <BulkReviewWorking verb="Approving" count={86} startedAtSec={started} />,
    );
    const live = screen.getByRole("status");
    const before = live.textContent;
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(live.textContent).toBe(before);
  });

  it("has no a11y violations", async () => {
    vi.useRealTimers();
    const { container } = render(
      <BulkReviewWorking verb="Approving" count={3} startedAtSec={started} />,
    );
    await expectNoA11yViolations(container);
  });
});
