import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { Sheet } from "./Sheet";

const panel = () => screen.getByRole("dialog", { name: "Detents" });
const slider = () => screen.getByRole("slider", { name: "Sheet height" });
const expand = () =>
  screen.getByRole("button", { name: "Expand to full height" });
const collapse = () =>
  screen.getByRole("button", { name: "Collapse to strip" });

type Props = Partial<ComponentProps<typeof Sheet>>;

const sheet = (props: Props = {}) => (
  <Sheet form="bottom" title="Detents" onClose={vi.fn()} {...props}>
    <p>Body</p>
  </Sheet>
);

describe("Sheet bottom, uncontrolled", () => {
  it("resizes itself with Expand and Collapse", async () => {
    render(sheet());
    expect(panel()).toHaveClass("bottom-sheet--half");
    await userEvent.click(expand());
    expect(panel()).toHaveClass("bottom-sheet--full");
    expect(slider()).toHaveAttribute("aria-valuetext", "Full height");
    await userEvent.click(collapse());
    expect(panel()).toHaveClass("bottom-sheet--peek");
  });

  it("follows the height slider", () => {
    render(sheet());
    fireEvent.change(slider(), { target: { value: "2" } });
    expect(panel()).toHaveClass("bottom-sheet--full");
    fireEvent.change(slider(), { target: { value: "0" } });
    expect(panel()).toHaveClass("bottom-sheet--peek");
  });

  it("starts full when asked and can still collapse", async () => {
    render(sheet({ detent: "full" }));
    expect(panel()).toHaveClass("bottom-sheet--full");
    await userEvent.click(collapse());
    expect(panel()).toHaveClass("bottom-sheet--peek");
  });

  it("starts at the default height again each time it opens", async () => {
    const { rerender } = render(sheet());
    await userEvent.click(expand());
    expect(panel()).toHaveClass("bottom-sheet--full");
    rerender(sheet({ open: false }));
    rerender(sheet({ open: true }));
    expect(panel()).toHaveClass("bottom-sheet--half");
  });
});

describe("Sheet bottom, controlled", () => {
  it("asks the host and keeps the detent prop until it changes", async () => {
    const onDetentChange = vi.fn();
    const { rerender } = render(sheet({ detent: "half", onDetentChange }));
    await userEvent.click(expand());
    expect(onDetentChange).toHaveBeenCalledWith("full");
    expect(panel()).toHaveClass("bottom-sheet--half");
    rerender(sheet({ detent: "full", onDetentChange }));
    expect(panel()).toHaveClass("bottom-sheet--full");
  });
});

describe("Sheet bottom, fit", () => {
  it("has no resize controls", () => {
    render(sheet({ detent: "fit" }));
    expect(screen.queryByRole("slider")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Expand|Collapse/ }),
    ).toBeNull();
  });
});
