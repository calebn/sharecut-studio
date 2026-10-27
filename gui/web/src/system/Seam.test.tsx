import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Seam } from "./Seam";

const cut = {
  form: "diamond",
  kind: "cut",
  label: "Cut at 12:04.3",
  detail: "2.4 s removed",
  onSelect: () => undefined,
} as const;

describe("Seam as a diamond", () => {
  it("names the seam and selects it on click", async () => {
    const onSelect = vi.fn();
    render(<Seam {...cut} onSelect={onSelect} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Cut at 12:04.3, 2.4 s removed" }),
    );
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("tells a cut from a split and a selected seam from the rest", () => {
    const { container, rerender } = render(<Seam {...cut} />);
    const seam = () => container.querySelector(".sys-seam");
    expect(seam()).toHaveAttribute("data-kind", "cut");
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
    rerender(<Seam {...cut} kind="split" label="Split at 12:04.3" selected />);
    expect(seam()).toHaveAttribute("data-kind", "split");
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the label and detail while the pointer is over it", () => {
    render(<Seam {...cut} />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Cut at 12:04.32.4 s removed",
    );
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("never opens a tip for a touch", () => {
    render(<Seam {...cut} />);
    fireEvent.pointerEnter(screen.getByRole("button"), {
      pointerType: "touch",
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("closes the tip on Escape and opens it again after the pointer leaves", () => {
    render(<Seam {...cut} />);
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("opens the tip for keyboard focus", async () => {
    const user = userEvent.setup();
    render(<Seam {...cut} />);
    await user.tab();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Cut at 12:04.3");
    await user.tab();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("Seam as a text pill", () => {
  const pill = {
    form: "pill",
    removed: "2.4 s",
    words: "so, um, you know",
    onSelect: () => undefined,
  } as const;

  it("shows the removed length and puts it in the name", () => {
    render(<Seam {...pill} />);
    const button = screen.getByRole("button", { name: "Cut, 2.4 s removed" });
    expect(button).toHaveTextContent("2.4 s");
  });

  it("describes the cut words without a tip, as a touch or screen reader meets it", () => {
    render(<Seam {...pill} />);
    expect(screen.getByRole("button")).toHaveAccessibleDescription(
      "so, um, you know",
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("names a diamond with its detail, and by its label alone without one", () => {
    const { rerender } = render(<Seam {...cut} />);
    expect(screen.getByRole("button")).toHaveAccessibleName(
      "Cut at 12:04.3, 2.4 s removed",
    );
    rerender(<Seam {...cut} detail={undefined} />);
    expect(screen.getByRole("button")).toHaveAccessibleName("Cut at 12:04.3");
  });

  it("shows the cut words on hover", () => {
    render(<Seam {...pill} />);
    fireEvent.pointerEnter(screen.getByRole("button"), {
      pointerType: "mouse",
    });
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Cut 2.4 sso, um, you know",
    );
  });

  it("has no tip when it does not know the words", () => {
    render(<Seam {...pill} words={undefined} />);
    fireEvent.pointerEnter(screen.getByRole("button"), {
      pointerType: "mouse",
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("selects on click", async () => {
    const onSelect = vi.fn();
    render(<Seam {...pill} onSelect={onSelect} selected />);
    await userEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });
});
