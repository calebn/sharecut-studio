import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import {
  EmptyState,
  Pill,
  pillClassName,
  SegmentedControl,
  Timecode,
  ToggleButton,
} from "./index";

describe("SegmentedControl", () => {
  it("names its group and marks the pressed segment", async () => {
    const { container } = render(
      <SegmentedControl label="Audition mode">
        <ToggleButton quiet pressed>
          Mix
        </ToggleButton>
        <ToggleButton quiet pressed={false}>
          FX
        </ToggleButton>
      </SegmentedControl>,
    );
    const group = screen.getByRole("group", { name: "Audition mode" });
    expect(group).toHaveClass("ui-segmented");
    expect(screen.getByRole("button", { name: "Mix" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expectNoA11yViolations(container);
  });

  it("drops the group name when rendered as menu radios", () => {
    const { container } = render(
      <SegmentedControl role="none" label="Audition mode">
        <span />
      </SegmentedControl>,
    );
    const track = container.querySelector(".ui-segmented");
    expect(track).toHaveAttribute("role", "none");
    expect(track).not.toHaveAttribute("aria-label");
  });
});

describe("Pill", () => {
  it("maps tone to the status class", () => {
    const { container } = render(
      <>
        <Pill tone="ok">Fresh</Pill>
        <Pill>Neutral</Pill>
      </>,
    );
    const [ok, neutral] = container.querySelectorAll(".pill");
    expect(ok).toHaveClass("pill", "ok");
    expect(neutral.className).toBe("pill");
  });

  it("shares the tone mapping with action pills", () => {
    expect(pillClassName("warning", "pill--action", false)).toBe(
      "pill warning pill--action",
    );
    expect(pillClassName()).toBe("pill");
  });
});

describe("Timecode", () => {
  it("shows the total only when provided", () => {
    const { container, rerender } = render(
      <Timecode current="00:01.000" total="01:00.000" title="t" />,
    );
    expect(container.textContent).toBe("00:01.000 / 01:00.000");
    rerender(<Timecode current="00:01.000" title="t" />);
    expect(container.querySelector(".timecode-total")).toBeNull();
  });
});

describe("EmptyState", () => {
  it("renders quiet text and can announce as status", () => {
    render(<EmptyState role="status">No live review links.</EmptyState>);
    const empty = screen.getByRole("status");
    expect(empty).toHaveClass("ui-empty-state");
    expect(empty.tagName).toBe("P");
  });

  it("renders as a list item inside lists", () => {
    render(
      <ul>
        <EmptyState as="li">No comments yet.</EmptyState>
      </ul>,
    );
    const item = screen.getByRole("listitem");
    expect(item).toHaveClass("ui-empty-state");
    expect(item).toHaveTextContent("No comments yet.");
  });
});
