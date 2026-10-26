import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusGlyph } from "./StatusGlyph";
import { StatusRow } from "./StatusRow";

describe("StatusRow progress", () => {
  it.each([
    [-0.2, "0", "0%"],
    [0.6, "60", "60%"],
    [1.4, "100", "100%"],
    [Number.NaN, "0", "0%"],
  ])("holds %s to 0..100", (progress, now, width) => {
    const { container } = render(
      <StatusRow state="running" title="Transcribe" progress={progress} />,
    );
    const bar = screen.getByRole("progressbar", { name: "Transcribe" });
    expect(bar).toHaveAttribute("aria-valuenow", now);
    expect((bar.firstElementChild as HTMLElement).style.inlineSize).toBe(width);
    expect(container.querySelector("circle:last-of-type")).not.toBeNull();
  });

  it("has no bar unless it runs", () => {
    render(<StatusRow state="queued" title="Clean and level" progress={0.5} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("StatusGlyph progress", () => {
  const dash = (container: HTMLElement) =>
    container
      .querySelectorAll("circle")[1]
      ?.getAttribute("stroke-dasharray")
      ?.split(" ")[0];

  it("draws the ring from the clamped value", () => {
    const length = 2 * Math.PI * 9;
    const over = render(<StatusGlyph state="running" progress={1.4} />);
    expect(Number(dash(over.container))).toBeCloseTo(length);
    const under = render(<StatusGlyph state="running" progress={-0.2} />);
    expect(Number(dash(under.container))).toBe(0);
    const nan = render(<StatusGlyph state="running" progress={Number.NaN} />);
    expect(Number(dash(nan.container))).toBe(0);
  });

  it("names the state in hidden text", () => {
    render(<StatusGlyph state="needs-you" />);
    expect(screen.getByText("Needs you")).toHaveClass("sr-only");
  });
});
