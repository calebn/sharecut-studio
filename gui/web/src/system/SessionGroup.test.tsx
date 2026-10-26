import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionGroup, type SessionGroupProps } from "./SessionGroup";

function Group(props: Partial<SessionGroupProps>) {
  return (
    <SessionGroup
      title="Session 1"
      people={3}
      takes={2}
      duration="14:20"
      target="start"
      status="idle"
      handoff={{ stage: "edit", label: "Open in Edit", onActivate: vi.fn() }}
      {...props}
    >
      {props.children === undefined ? <p>Takes here</p> : props.children}
    </SessionGroup>
  );
}

describe("SessionGroup", () => {
  it("has a heading, the stats and the target in its header", () => {
    render(<Group />);
    expect(
      screen.getByRole("heading", { level: 3, name: "Session 1" }),
    ).toBeVisible();
    expect(screen.getByText("3 people · 2 takes · 14:20")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Where this session goes: Starts the episode",
      }),
    ).toBeVisible();
    expect(screen.getByText("Takes here")).toBeVisible();
  });

  it("uses the singular", () => {
    render(<Group people={1} takes={1} />);
    expect(screen.getByText("1 person · 1 take · 14:20")).toBeVisible();
  });

  it("is a progressbar with a value and text while it runs", () => {
    render(<Group status="running" progress={0.4} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "40");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuetext", "Transcribing, 40%");
    expect(screen.getByText("Transcribing, 40%")).toBeVisible();
  });

  it.each([
    ["idle", "Not started"],
    ["done", "Transcribed"],
    ["failed", "Transcription failed"],
  ] as const)("says %s in words and has no progressbar", (status, text) => {
    render(<Group status={status} />);
    expect(screen.getByText(text)).toBeVisible();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("says when empty", () => {
    render(
      <Group takes={0} people={0}>
        {null}
      </Group>,
    );
    expect(screen.getByText("No takes yet. Add audio to start.")).toBeVisible();
  });

  it("hands off secondary until done, then primary", () => {
    const { rerender } = render(<Group status="running" progress={0.2} />);
    const button = () => screen.getByRole("button", { name: "Open in Edit" });
    expect(button()).not.toHaveClass("primary");
    rerender(<Group status="done" />);
    expect(button()).toHaveClass("primary");
    expect(document.querySelectorAll(".primary")).toHaveLength(1);
  });

  it("keeps the hand-off in the group's footer and gives the reason when blocked", async () => {
    const onActivate = vi.fn();
    render(
      <Group
        status="failed"
        handoff={{
          stage: "edit",
          label: "Open in Edit",
          onActivate,
          disabledReason: "Fix the failed take first.",
        }}
      />,
    );
    const button = screen.getByRole("button", { name: "Open in Edit" });
    expect(screen.getByText("Fix the failed take first.")).toBeVisible();
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(button);
    expect(onActivate).not.toHaveBeenCalled();
    expect(button.closest("footer")).not.toBeNull();
    expect(screen.getByRole("region", { name: "Session 1" })).toContainElement(
      button,
    );
  });

  it("renders no footer or hand-off when the stage owns it", () => {
    render(<Group handoff={undefined} />);
    expect(screen.queryByRole("button", { name: "Open in Edit" })).toBeNull();
    expect(document.querySelector("footer")).toBeNull();
    expect(screen.getByText("Takes here")).toBeVisible();
  });

  it.each([
    [-0.2, "0", "Transcribing, 0%"],
    [1.4, "100", "Transcribing, 100%"],
    [Number.NaN, "0", "Transcribing, 0%"],
  ])("holds progress %s to 0..100", (progress, now, text) => {
    render(<Group status="running" progress={progress} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", now);
    expect(bar).toHaveAttribute("aria-valuetext", text);
  });
});
