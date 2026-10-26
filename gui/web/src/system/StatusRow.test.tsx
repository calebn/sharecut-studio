import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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

  it("says the bar in words when there is no detail, and prefers the detail", () => {
    const { rerender } = render(
      <StatusRow state="running" title="Clean and level" progress={0.3} />,
    );
    const bar = () => screen.getByRole("progressbar");
    expect(bar()).toHaveAttribute("aria-valuetext", "30 percent");
    rerender(
      <StatusRow
        state="running"
        title="Clean and level"
        progress={0.3}
        detail="Step 2 of 4"
      />,
    );
    expect(bar()).toHaveAttribute("aria-valuetext", "Step 2 of 4");
    rerender(
      <StatusRow
        state="running"
        title="Uploading"
        progress={0.62}
        detail="62%"
        valueText="62 percent"
      />,
    );
    expect(bar()).toHaveAttribute("aria-valuetext", "62 percent");
  });

  it("has no bar unless it runs", () => {
    render(<StatusRow state="queued" title="Clean and level" progress={0.5} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("StatusRow failed", () => {
  it("shows the cause, a primary Try again, and Details that open the technical cause", async () => {
    const user = userEvent.setup();
    render(
      <StatusRow
        state="failed"
        title="Transcribe"
        detail="Not enough memory"
        details="Out of memory while decoding track 2."
        action={{ label: "Try again", onAction: vi.fn() }}
      />,
    );
    expect(screen.getByText("Not enough memory")).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toHaveClass(
      "primary",
    );
    const details = screen.getByRole("button", {
      name: "Details for Transcribe",
    });
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/decoding track 2/)).toBeNull();
    await user.click(details);
    expect(details).toHaveAttribute("aria-expanded", "true");
    expect(details).toHaveAttribute(
      "aria-controls",
      screen.getByText(/decoding track 2/).id,
    );
  });

  it("has no Details button without a technical cause or outside failure", () => {
    const { rerender } = render(
      <StatusRow
        state="failed"
        title="Transcribe"
        detail="Not enough memory"
      />,
    );
    expect(screen.queryByRole("button", { name: /Details/ })).toBeNull();
    rerender(<StatusRow state="done" title="Transcribe" details="x" />);
    expect(screen.queryByRole("button", { name: /Details/ })).toBeNull();
  });

  it("separates the hidden state from the title", () => {
    const { container } = render(
      <StatusRow state="needs-you" title="Line up tracks" />,
    );
    expect(container).toHaveTextContent("Needs you: Line up tracks");
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

  it("shows no Details button for a cause that is only spaces", () => {
    render(<StatusRow state="failed" title="Transcribe" details="   " />);
    expect(screen.queryByRole("button", { name: /^Details/ })).toBeNull();
  });

  it("trims the cause and closes Details when the row leaves failed", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <StatusRow
        state="failed"
        title="Transcribe"
        details="  Out of memory  "
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Details for Transcribe" }),
    );
    expect(screen.getByText("Out of memory").textContent).toBe("Out of memory");
    rerender(
      <StatusRow
        state="running"
        title="Transcribe"
        details="  Out of memory  "
      />,
    );
    rerender(
      <StatusRow
        state="failed"
        title="Transcribe"
        details="  Out of memory  "
      />,
    );
    expect(
      screen.getByRole("button", { name: "Details for Transcribe" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Out of memory")).toBeNull();
  });

  it.each([false, 0, "", null, undefined])(
    "is not expandable for children %s",
    (children) => {
      render(
        <StatusRow state="done" title="Add audio">
          {children}
        </StatusRow>,
      );
      expect(screen.queryByRole("button")).toBeNull();
    },
  );
});
