import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import {
  CLIP_LABEL_MIN_WIDTH,
  CLIP_NARROW_WIDTH,
  Clip,
  type ClipProps,
} from "./Clip";

const base: ClipProps = {
  name: "Maya, take 2",
  colorIndex: 1,
  start: 12,
  duration: 4,
  pxPerSecond: 40,
  fadeIn: 250,
  fadeOut: 500,
  room: { before: 1.5, after: 2 },
  onSelect: () => undefined,
};

function setup(over: Partial<ClipProps> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onDragStart: vi.fn(),
    onDrag: vi.fn(),
    onDragEnd: vi.fn(),
    onNudge: vi.fn(),
  };
  const view = render(<Clip {...base} {...handlers} {...over} />);
  const handle = (name: string) =>
    screen.getByRole("slider", { name: new RegExp(`^${name}`) });
  return { ...handlers, ...view, handle };
}

const body = () => screen.getByRole("button", { name: "Maya, take 2" });

describe("Clip label and size", () => {
  it("shows its name only when it is at least 80 px wide, and always names the button", () => {
    const { container, rerender } = render(
      <Clip
        {...base}
        duration={(CLIP_LABEL_MIN_WIDTH - 1) / base.pxPerSecond}
      />,
    );
    expect(container.querySelector(".sys-clip-label")).toBeNull();
    expect(body()).toBeInTheDocument();
    rerender(
      <Clip {...base} duration={CLIP_LABEL_MIN_WIDTH / base.pxPerSecond} />,
    );
    expect(container.querySelector(".sys-clip-label")).toHaveTextContent(
      "Maya, take 2",
    );
  });

  it("is its duration times the scale wide, with the fades as pixels of that scale", () => {
    const { container } = setup();
    const clip = container.querySelector<HTMLElement>(".sys-clip");
    expect(clip?.style.getPropertyValue("--sys-clip-width")).toBe("160px");
    expect(clip?.style.getPropertyValue("--sys-clip-fade-in")).toBe("10px");
    expect(clip?.style.getPropertyValue("--sys-clip-fade-out")).toBe("20px");
  });

  it("draws a fade only where there is one", () => {
    const { container, rerender } = render(<Clip {...base} fadeOut={0} />);
    expect(
      [...container.querySelectorAll(".sys-clip-fade")].map((f) =>
        f.getAttribute("data-edge"),
      ),
    ).toEqual(["in"]);
    rerender(<Clip {...base} fadeIn={0} />);
    expect(
      [...container.querySelectorAll(".sys-clip-fade")].map((f) =>
        f.getAttribute("data-edge"),
      ),
    ).toEqual(["out"]);
  });

  it("drops the fade knobs from a clip narrower than 48 px and keeps its trim edges", () => {
    setup({ duration: (CLIP_NARROW_WIDTH - 1) / base.pxPerSecond });
    expect(
      screen.getAllByRole("slider").map((s) => s.getAttribute("data-handle")),
    ).toEqual(["trim-in", "trim-out"]);
  });

  it("describes the muted part and places it by seconds", () => {
    const { container } = setup({ mutedRegions: [{ start: 1, end: 2.5 }] });
    expect(body()).toHaveAccessibleDescription("Part of this clip is muted");
    const region = container.querySelector<HTMLElement>(".sys-clip-muted");
    expect(region?.style.insetInlineStart).toBe("40px");
    expect(region?.style.inlineSize).toBe("60px");
  });

  it("draws the peaks it is given", () => {
    const { container } = setup({ peaks: [0.2, 0.8, 0.5] });
    expect(container.querySelectorAll(".sys-wave-peak")).toHaveLength(3);
  });
});

describe("Clip selection", () => {
  it("selects on click and on Enter, and says whether Shift or Ctrl extends", async () => {
    const user = userEvent.setup();
    const { onSelect } = setup();
    await user.click(body());
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    fireEvent.click(body(), { ctrlKey: true });
    expect(onSelect.mock.calls).toEqual([[false], [true], [true]]);
  });

  it("is one tab stop until selected, then its four handles join the order", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Clip {...base} />);
    const tabs = () =>
      screen
        .getAllByRole("slider")
        .filter((s) => s.tabIndex === 0)
        .map((s) => s.getAttribute("data-handle"));
    expect(tabs()).toEqual([]);
    await user.tab();
    expect(body()).toHaveFocus();
    rerender(<Clip {...base} selected />);
    expect(body()).toHaveAttribute("aria-pressed", "true");
    expect(tabs()).toEqual(["trim-in", "trim-out", "fade-in", "fade-out"]);
    await user.tab();
    expect(screen.getByRole("slider", { name: /^Trim start/ })).toHaveFocus();
  });

  it("hands the keys it does not use to its host", async () => {
    const user = userEvent.setup();
    const onKeyDown = vi.fn();
    setup({ onKeyDown });
    await user.tab();
    await user.keyboard("{ArrowDown}");
    expect(onKeyDown.mock.calls.map(([event]) => event.key)).toEqual([
      "ArrowDown",
    ]);
  });
});

describe("Clip handles", () => {
  it("reads as sliders with the edge time, the fade length and the room to move", () => {
    const { handle } = setup({ selected: true });
    const read = (el: HTMLElement) => [
      el.getAttribute("aria-valuemin"),
      el.getAttribute("aria-valuenow"),
      el.getAttribute("aria-valuemax"),
      el.getAttribute("aria-valuetext"),
    ];
    expect(read(handle("Trim start"))).toEqual(["10.5", "12", "16", "12 s"]);
    expect(read(handle("Trim end"))).toEqual(["12", "16", "18", "16 s"]);
    expect(read(handle("Fade in"))).toEqual(["0", "250", "4000", "250 ms"]);
    expect(read(handle("Fade out"))).toEqual(["0", "500", "4000", "500 ms"]);
  });

  it("nudges the edge 10 ms with an arrow and 100 ms with Shift", async () => {
    const user = userEvent.setup();
    const { handle, onNudge } = setup({ selected: true });
    handle("Trim end").focus();
    await user.keyboard("{ArrowRight}{Shift>}{ArrowLeft}{/Shift}");
    handle("Fade in").focus();
    await user.keyboard("{ArrowRight}");
    expect(onNudge.mock.calls).toEqual([
      ["trim-out", 10],
      ["trim-out", -100],
      ["fade-in", 10],
    ]);
  });

  it("ignores other keys on a handle", async () => {
    const user = userEvent.setup();
    const { handle, onNudge } = setup({ selected: true });
    handle("Trim start").focus();
    await user.keyboard("{ArrowUp}a");
    expect(onNudge).not.toHaveBeenCalled();
  });

  it("reports a handle drag from its first movement and ends it on release", () => {
    const { handle, onDragStart, onDrag, onDragEnd } = setup({
      selected: true,
    });
    const grip = handle("Trim end");
    fireEvent.pointerDown(grip, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 101 });
    expect(onDragStart).not.toHaveBeenCalled();
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 110, altKey: true });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 120 });
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 120 });
    expect(onDragStart.mock.calls).toEqual([["trim-out"]]);
    expect(onDrag.mock.calls).toEqual([
      ["trim-out", { x: 110, dx: 10, fine: true }],
      ["trim-out", { x: 120, dx: 20, fine: false }],
    ]);
    expect(onDragEnd.mock.calls).toEqual([["trim-out", true]]);
  });

  it("cancels a drag on Escape and takes nothing from the release that follows", async () => {
    const user = userEvent.setup();
    const { handle, onDrag, onDragEnd } = setup({ selected: true });
    const grip = handle("Fade out");
    grip.focus();
    fireEvent.pointerDown(grip, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 110 });
    await user.keyboard("{Escape}");
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 130 });
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 130 });
    expect(onDragEnd.mock.calls).toEqual([["fade-out", false]]);
    expect(onDrag).toHaveBeenCalledTimes(1);
  });

  it("ends a drag the browser took as not committed, once", () => {
    const { handle, onDragEnd } = setup({ selected: true });
    const grip = handle("Trim start");
    fireEvent.pointerDown(grip, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 110 });
    fireEvent.pointerCancel(grip, { pointerId: 1 });
    fireEvent.lostPointerCapture(grip, { pointerId: 1 });
    expect(onDragEnd.mock.calls).toEqual([["trim-in", false]]);
  });

  it("leaves Escape alone when nothing is being dragged, and takes it when one is", () => {
    const { handle } = setup({ selected: true });
    const grip = handle("Trim start");
    expect(fireEvent.keyDown(grip, { key: "Escape" })).toBe(true);
    fireEvent.pointerDown(grip, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 110 });
    expect(fireEvent.keyDown(grip, { key: "Escape" })).toBe(false);
  });
});

describe("Clip body drag", () => {
  it("moves on a drag, and the click that follows does not select", () => {
    const { onSelect, onDragStart, onDrag, onDragEnd } = setup();
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 50 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 80 });
    fireEvent.pointerUp(body(), { pointerId: 1, clientX: 80 });
    fireEvent.click(body());
    expect(onDragStart.mock.calls).toEqual([["move"]]);
    expect(onDrag.mock.calls).toEqual([
      ["move", { x: 80, dx: 30, fine: false }],
    ]);
    expect(onDragEnd.mock.calls).toEqual([["move", true]]);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(body());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("treats a press that barely moves as a tap that selects", () => {
    const { onSelect, onDragStart, onDragEnd } = setup();
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 50 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 52 });
    fireEvent.pointerUp(body(), { pointerId: 1, clientX: 52 });
    fireEvent.click(body());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onDragStart).not.toHaveBeenCalled();
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  it("ignores a press from another pointer or a right button", () => {
    const { onDrag } = setup();
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 50 });
    fireEvent.pointerMove(body(), { pointerId: 2, clientX: 90 });
    fireEvent.pointerUp(body(), { pointerId: 1 });
    fireEvent.pointerDown(body(), {
      pointerId: 3,
      clientX: 50,
      button: 2,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(body(), { pointerId: 3, clientX: 90 });
    expect(onDrag).not.toHaveBeenCalled();
  });
});

describe("Clip as a guest sees it", () => {
  it("has no handles and cannot be dragged, but can be selected", async () => {
    const user = userEvent.setup();
    const { onSelect, onDragStart } = setup({ readOnly: true, selected: true });
    expect(screen.queryByRole("slider")).toBeNull();
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 50 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 90 });
    fireEvent.pointerUp(body(), { pointerId: 1, clientX: 90 });
    expect(onDragStart).not.toHaveBeenCalled();
    await user.click(body());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(body()).not.toHaveAttribute("data-movable");
  });
});

describe("Clip accessibility", () => {
  it("has no axe violations idle, selected, muted or read-only", async () => {
    for (const over of [
      {},
      { selected: true, peaks: [0.3, 0.9] },
      { mutedRegions: [{ start: 0, end: 1 }] },
      { readOnly: true },
    ] satisfies Partial<ClipProps>[]) {
      const { container, unmount } = setup(over);
      await expectNoA11yViolations(container);
      unmount();
    }
  });
});
