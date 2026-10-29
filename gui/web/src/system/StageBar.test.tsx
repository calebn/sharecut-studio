import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StageBar, type StageBarProps } from "./StageBar";

// ui.css scales a pressed `.ui-control`. A tab shares its edges with its
// neighbours, so a scale would move its hit edge and lose the click; the tabs
// keep a colour-only press by not being `.ui-control`s at all.
it.each(["bar", "tabs"] as const)(
  "the %s form's tabs are not press-scaled controls",
  (form) => {
    render(<StageBar active="edit" onSelect={vi.fn()} form={form} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(5);
    for (const tab of tabs) {
      expect(tab.classList.contains("ui-control")).toBe(false);
      expect(tab.closest(".ui-control")).toBeNull();
    }
  },
);

describe("the Record badge", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const record = (badge: StageBarProps["record"], form?: "bar" | "tabs") =>
    render(
      <StageBar active="edit" onSelect={vi.fn()} record={badge} form={form} />,
    );

  it.each([
    [{ kind: "idle" } as const, "Record"],
    [{ kind: "waiting", count: 2 } as const, "Record 2 waiting"],
    [{ kind: "live", clockMs: 0, receivedAtMs: null } as const, "Record Live"],
    [
      { kind: "live", clockMs: 0, receivedAtMs: null, alert: true } as const,
      "Record Live, needs attention",
    ],
    [{ kind: "paused" } as const, "Record Paused"],
    [{ kind: "saving", progress: 0.5 } as const, "Record Saving"],
    [{ kind: "alert" } as const, "Record Needs attention"],
  ])("names %j without the clock", (badge, name) => {
    record(badge);
    expect(screen.getByRole("tab", { name })).toBeInTheDocument();
  });

  it("shows the take clock from the snapshot and ticks it by the second", () => {
    vi.useFakeTimers();
    record({
      kind: "live",
      clockMs: 724000,
      receivedAtMs: performance.now(),
    });
    expect(screen.getByText("12:04")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText("12:07")).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Record Live" }),
    ).toBeInTheDocument();
  });

  it("shows Paused in words", () => {
    record({ kind: "paused" });
    expect(document.querySelector(".sys-pill-text")).toHaveTextContent(
      "Paused",
    );
  });

  it("keeps the failed badge over the room badge", () => {
    render(
      <StageBar
        active="edit"
        onSelect={vi.fn()}
        badges={{ record: { kind: "failed" } }}
        record={{ kind: "live", clockMs: 0, receivedAtMs: null }}
      />,
    );
    expect(
      screen.getByRole("tab", { name: "Record Failed" }),
    ).toBeInTheDocument();
  });

  it("does not re-render the tabs when the clock ticks", () => {
    vi.useFakeTimers();
    record(
      { kind: "live", clockMs: 0, receivedAtMs: performance.now() },
      "tabs",
    );
    const tab = screen.getByRole("tab", { name: "Record Live" });
    const label = tab.querySelector(".sys-stage-label");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("tab", { name: "Record Live" })).toBe(tab);
    expect(tab.querySelector(".sys-stage-label")).toBe(label);
  });
});
