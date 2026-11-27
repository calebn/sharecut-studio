import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("Sheet bottom, initial focus", () => {
  const frames: FrameRequestCallback[] = [];
  const nextFrame = () => act(() => frames.shift()?.(0));
  const holdFrames = () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
  };

  afterEach(() => {
    frames.length = 0;
    vi.restoreAllMocks();
  });

  it("focuses the control initialFocusRef names", () => {
    holdFrames();
    const target = createRef<HTMLButtonElement>();
    render(
      <Sheet
        form="bottom"
        title="Detents"
        onClose={vi.fn()}
        initialFocusRef={target}
      >
        <button ref={target} type="button">
          Primary
        </button>
      </Sheet>,
    );
    nextFrame();
    expect(screen.getByRole("button", { name: "Primary" })).toHaveFocus();
  });

  it("falls back to Close, not the height slider, when the ref is empty", () => {
    holdFrames();
    render(
      sheet({
        detent: "full",
        initialFocusRef: createRef<HTMLButtonElement>(),
      }),
    );
    nextFrame();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("keeps focus on a control that took it before the first frame", () => {
    holdFrames();
    const target = createRef<HTMLButtonElement>();
    render(
      <Sheet
        form="bottom"
        title="Detents"
        onClose={vi.fn()}
        initialFocusRef={target}
      >
        <button ref={target} type="button">
          Primary
        </button>
      </Sheet>,
    );
    act(() => screen.getByRole("button", { name: "Primary" }).focus());
    nextFrame();
    expect(screen.getByRole("button", { name: "Primary" })).toHaveFocus();
  });

  it("leaves focus on the step's Back when a step is pushed", () => {
    holdFrames();
    const target = createRef<HTMLButtonElement>();
    const ui = (step: Props["step"]) => (
      <Sheet
        form="bottom"
        title="Detents"
        onClose={vi.fn()}
        initialFocusRef={target}
        step={step}
        footer={
          <button ref={target} type="button">
            Done
          </button>
        }
      >
        <p>Body</p>
      </Sheet>
    );
    const { rerender } = render(ui(null));
    nextFrame();
    expect(screen.getByRole("button", { name: "Done" })).toHaveFocus();
    rerender(
      ui({ title: "Step", onBack: vi.fn(), children: <p>Step body</p> }),
    );
    while (frames.length) nextFrame();
    expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
  });
});
