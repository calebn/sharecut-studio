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
  id: "clip-1",
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
    onNudgeEnd: vi.fn(),
    onLaneStep: vi.fn(),
  };
  const view = render(<Clip {...base} {...handlers} {...over} />);
  const handle = (name: string) =>
    screen.getByRole("slider", { name: new RegExp(`^${name}`) });
  return { ...handlers, ...view, handle };
}

const body = () => screen.getByRole("button", { name: "Maya, take 2" });

describe("Clip label and size", () => {
  it("shows its name only when it is wider than 80 px, and always names the button", () => {
    const { container, rerender } = render(
      <Clip {...base} duration={CLIP_LABEL_MIN_WIDTH / base.pxPerSecond} />,
    );
    expect(container.querySelector(".sys-clip-label")).toBeNull();
    expect(body()).toBeInTheDocument();
    rerender(
      <Clip
        {...base}
        duration={(CLIP_LABEL_MIN_WIDTH + 1) / base.pxPerSecond}
      />,
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

  it("draws at most one bar per pixel of its width, however many peaks it is given", () => {
    const peaks = Array.from({ length: 10_000 }, (_, i) => (i % 100) / 100);
    const { container } = setup({ peaks });
    expect(container.querySelectorAll(".sys-wave-peak")).toHaveLength(160);
  });

  it("draws a ghost with no button, handles or place in the accessibility tree", () => {
    const { container } = setup({ ghost: true, selected: true });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(container.querySelector(".sys-clip")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(container.querySelector(".sys-clip-label")).toHaveTextContent(
      "Maya, take 2",
    );
  });

  it("passes the host's hit and anchor attributes to the root, the body and each handle", () => {
    const { container, handle } = setup({
      selected: true,
      anchorProps: { "data-presence-anchor": "clip:clip-1" },
      hitProps: {
        move: { "data-hit-kind": "clip", "data-hit-id": "clip-1" },
        "fade-in": { "data-hit-kind": "fade" },
      },
    });
    expect(container.querySelector(".sys-clip")).toHaveAttribute(
      "data-presence-anchor",
      "clip:clip-1",
    );
    expect(container.querySelector(".sys-clip")).toHaveAttribute(
      "data-clip-id",
      "clip-1",
    );
    expect(body()).toHaveAttribute("data-hit-kind", "clip");
    expect(body()).toHaveAttribute("data-hit-id", "clip-1");
    expect(handle("Fade in")).toHaveAttribute("data-hit-kind", "fade");
    expect(handle("Fade out")).not.toHaveAttribute("data-hit-kind");
  });
});

describe("Clip selection", () => {
  it("selects on click and on Enter, and says whether Shift or Ctrl and Cmd are held", async () => {
    const user = userEvent.setup();
    const { onSelect } = setup();
    await user.click(body());
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    fireEvent.click(body(), { ctrlKey: true });
    fireEvent.click(body(), { metaKey: true });
    expect(onSelect.mock.calls).toEqual([
      ["clip-1", { shift: false, mod: false }],
      ["clip-1", { shift: true, mod: false }],
      ["clip-1", { shift: false, mod: true }],
      ["clip-1", { shift: false, mod: true }],
    ]);
  });

  it("is one tab stop, selected or not, and the handles are never tab stops", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <>
        <Clip {...base} />
        <Clip {...base} id="clip-2" name="Maya, take 3" />
      </>,
    );
    await user.tab();
    expect(body()).toHaveFocus();
    rerender(
      <>
        <Clip {...base} selected />
        <Clip {...base} id="clip-2" name="Maya, take 3" />
      </>,
    );
    expect(
      screen.getAllByRole("slider").map((s) => s.getAttribute("tabindex")),
    ).toEqual(Array(8).fill("-1"));
    await user.tab();
    expect(screen.getByRole("button", { name: "Maya, take 3" })).toHaveFocus();
  });

  it("lets a lane take the body out of the tab order", () => {
    render(<Clip {...base} tabIndex={-1} />);
    expect(body()).toHaveAttribute("tabindex", "-1");
  });

  it("walks focus from the body along the four handles with Alt and Left or Right, only once selected", async () => {
    const user = userEvent.setup();
    const onKeyDown = vi.fn();
    const { rerender } = render(<Clip {...base} onKeyDown={onKeyDown} />);
    body().focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(body()).toHaveFocus();
    rerender(<Clip {...base} selected onKeyDown={onKeyDown} />);
    const focused: (string | null)[] = [];
    for (let step = 0; step < 5; step++) {
      await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
      focused.push(document.activeElement?.getAttribute("data-handle") ?? null);
    }
    expect(focused).toEqual([
      "trim-in",
      "fade-in",
      "fade-out",
      "trim-out",
      "trim-out",
    ]);
    for (let step = 0; step < 3; step++) {
      await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    }
    expect(document.activeElement).toBe(
      screen.getByRole("slider", { name: /^Trim start/ }),
    );
    await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(body()).toHaveFocus();
  });

  it("skips the fade handles on a clip too narrow to have them", async () => {
    const user = userEvent.setup();
    render(
      <Clip
        {...base}
        selected
        duration={(CLIP_NARROW_WIDTH - 1) / base.pxPerSecond}
      />,
    );
    body().focus();
    await user.keyboard("{Alt>}{ArrowRight}{ArrowRight}{/Alt}");
    expect(document.activeElement?.getAttribute("data-handle")).toBe(
      "trim-out",
    );
  });

  it("hands the keys it does not use to its host with the clip's id, and keeps Up and Down as lane steps", async () => {
    const user = userEvent.setup();
    const onKeyDown = vi.fn();
    const onLaneStep = vi.fn();
    setup({ onKeyDown, onLaneStep });
    await user.tab();
    await user.keyboard(
      "{ArrowRight}{ArrowDown}{ArrowUp}{Shift>}{ArrowDown}{/Shift}",
    );
    expect(
      onKeyDown.mock.calls
        .filter(([, event]) => event.key.startsWith("Arrow"))
        .map(([id, event]) => [id, event.key, event.shiftKey]),
    ).toEqual([
      ["clip-1", "ArrowRight", false],
      ["clip-1", "ArrowDown", true],
    ]);
    expect(onLaneStep.mock.calls).toEqual([
      ["clip-1", 1],
      ["clip-1", -1],
    ]);
  });
});

describe("Clip handles", () => {
  it("reads as sliders with the edge as a timecode, the fade length and the room to move", () => {
    const { handle } = setup({ selected: true });
    const read = (el: HTMLElement) => [
      el.getAttribute("aria-valuemin"),
      el.getAttribute("aria-valuenow"),
      el.getAttribute("aria-valuemax"),
      el.getAttribute("aria-valuetext"),
    ];
    expect(read(handle("Trim start"))).toEqual([
      "10.5",
      "12",
      "15.95",
      "00:12.000",
    ]);
    expect(read(handle("Trim end"))).toEqual([
      "12.05",
      "16",
      "18",
      "00:16.000",
    ]);
    expect(read(handle("Fade in"))).toEqual(["0", "250", "3500", "250 ms"]);
    expect(read(handle("Fade out"))).toEqual(["250", "3500", "4000", "500 ms"]);
  });

  it("stops each fade at the other, so the two never cross", () => {
    const { handle } = setup({ selected: true, fadeIn: 3000, fadeOut: 500 });
    expect(handle("Fade in")).toHaveAttribute("aria-valuemax", "3500");
    expect(handle("Fade out")).toHaveAttribute("aria-valuemin", "3000");
  });

  it("raises a fade-out slider's value when its knob moves later, as Right does for any slider", () => {
    const { handle, rerender } = setup({ selected: true });
    expect(handle("Fade out")).toHaveAttribute("aria-valuenow", "3500");
    rerender(<Clip {...base} selected fadeOut={490} />);
    expect(handle("Fade out")).toHaveAttribute("aria-valuenow", "3510");
    expect(handle("Fade out")).toHaveAttribute("aria-valuetext", "490 ms");
  });

  it("nudges the edge 10 ms with an arrow and 100 ms with Shift, and keeps the arrow from its parents", async () => {
    const user = userEvent.setup();
    const above = vi.fn();
    const onNudge = vi.fn();
    render(
      <div
        role="toolbar"
        aria-label="keymap"
        onKeyDown={(event) => event.key.startsWith("Arrow") && above()}
      >
        <Clip {...base} selected onNudge={onNudge} />
      </div>,
    );
    const handle = (name: string) =>
      screen.getByRole("slider", { name: new RegExp(`^${name}`) });
    handle("Trim end").focus();
    await user.keyboard("{ArrowRight}{Shift>}{ArrowLeft}{/Shift}");
    handle("Fade in").focus();
    await user.keyboard("{ArrowRight}");
    expect(onNudge.mock.calls).toEqual([
      ["clip-1", "trim-out", 10, { repeat: false }],
      ["clip-1", "trim-out", -100, { repeat: false }],
      ["clip-1", "fade-in", 10, { repeat: false }],
    ]);
    expect(above).not.toHaveBeenCalled();
  });

  it("marks a held key as a repeat and ends the nudge once, on release", () => {
    const { handle, onNudge, onNudgeEnd } = setup({ selected: true });
    const grip = handle("Trim start");
    fireEvent.keyDown(grip, { key: "ArrowLeft" });
    fireEvent.keyDown(grip, { key: "ArrowLeft", repeat: true });
    fireEvent.keyDown(grip, { key: "ArrowLeft", repeat: true });
    expect(onNudge.mock.calls.map(([, , , nudge]) => nudge.repeat)).toEqual([
      false,
      true,
      true,
    ]);
    expect(onNudgeEnd).not.toHaveBeenCalled();
    fireEvent.keyUp(grip, { key: "ArrowLeft" });
    fireEvent.keyUp(grip, { key: "ArrowLeft" });
    expect(onNudgeEnd.mock.calls).toEqual([["clip-1", "trim-in"]]);
  });

  it("ends a nudge when focus leaves the handle or the clip goes away", () => {
    const { handle, onNudgeEnd, unmount } = setup({ selected: true });
    fireEvent.keyDown(handle("Fade out"), { key: "ArrowRight" });
    fireEvent.blur(handle("Fade out"));
    fireEvent.keyDown(handle("Trim end"), { key: "ArrowRight" });
    unmount();
    expect(onNudgeEnd.mock.calls).toEqual([
      ["clip-1", "fade-out"],
      ["clip-1", "trim-out"],
    ]);
  });

  it("sends Up and Down on a handle to the lane and ignores other keys", async () => {
    const user = userEvent.setup();
    const { handle, onNudge, onLaneStep } = setup({ selected: true });
    handle("Trim start").focus();
    await user.keyboard("{ArrowDown}a");
    expect(onLaneStep.mock.calls).toEqual([["clip-1", 1]]);
    expect(onNudge).not.toHaveBeenCalled();
  });

  it("reports a handle drag from its first movement with the pointer and keys, and ends it on release", () => {
    const { handle, onDragStart, onDrag, onDragEnd } = setup({
      selected: true,
    });
    const grip = handle("Trim end");
    fireEvent.pointerDown(grip, { pointerId: 1, clientX: 100, clientY: 40 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 101, clientY: 40 });
    expect(onDragStart).not.toHaveBeenCalled();
    fireEvent.pointerMove(grip, {
      pointerId: 1,
      clientX: 110,
      clientY: 44,
      altKey: true,
    });
    fireEvent.pointerMove(grip, {
      pointerId: 1,
      clientX: 120,
      clientY: 40,
      shiftKey: true,
    });
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 120 });
    expect(onDragStart.mock.calls).toEqual([
      [
        "clip-1",
        "trim-out",
        { clientX: 110, clientY: 44, shift: false, alt: true },
      ],
    ]);
    expect(onDrag.mock.calls).toEqual([
      [
        "clip-1",
        "trim-out",
        { clientX: 110, clientY: 44, dx: 10, dy: 4, shift: false, alt: true },
      ],
      [
        "clip-1",
        "trim-out",
        { clientX: 120, clientY: 40, dx: 20, dy: 0, shift: true, alt: false },
      ],
    ]);
    expect(onDragEnd.mock.calls).toEqual([["clip-1", "trim-out", true]]);
  });

  it("ends a drag the browser took as not committed, once", () => {
    const { handle, onDragEnd } = setup({ selected: true });
    const grip = handle("Trim start");
    fireEvent.pointerDown(grip, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 110 });
    fireEvent.pointerCancel(grip, { pointerId: 1 });
    fireEvent.lostPointerCapture(grip, { pointerId: 1 });
    expect(onDragEnd.mock.calls).toEqual([["clip-1", "trim-in", false]]);
  });
});

describe("Clip cancelling a drag", () => {
  const dragging = (over: Partial<ClipProps> = {}) => {
    const view = setup({ selected: true, ...over });
    const grip = view.handle("Fade out");
    fireEvent.pointerDown(grip, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 110 });
    return { ...view, grip };
  };

  it("takes Escape from the document wherever focus is, and takes nothing from the release that follows", () => {
    const { grip, onDrag, onDragEnd } = dragging();
    document.body.focus();
    const handled = fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 130 });
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 130 });
    expect(handled).toBe(false);
    expect(onDragEnd.mock.calls).toEqual([["clip-1", "fade-out", false]]);
    expect(onDrag).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape alone when nothing is being dragged, or the press has not moved", () => {
    const { handle } = setup({ selected: true });
    const grip = handle("Trim start");
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);
    fireEvent.pointerDown(grip, { pointerId: 1, clientX: 100 });
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);
  });

  it("ends the drag as not committed when the window loses focus", () => {
    const { onDragEnd } = dragging();
    fireEvent.blur(window);
    expect(onDragEnd.mock.calls).toEqual([["clip-1", "fade-out", false]]);
  });

  it("ends the drag as not committed when the clip leaves the page mid-drag, once", () => {
    const { onDragEnd, unmount } = dragging();
    unmount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onDragEnd.mock.calls).toEqual([["clip-1", "fade-out", false]]);
  });

  it("ignores a second pointer while one has hold, and finishes with the first", () => {
    const { grip, onDrag, onDragEnd } = dragging();
    fireEvent.pointerDown(grip, { pointerId: 2, clientX: 300 });
    fireEvent.pointerMove(grip, { pointerId: 2, clientX: 400 });
    fireEvent.pointerUp(grip, { pointerId: 2, clientX: 400 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 120 });
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 120 });
    expect(onDrag.mock.calls.map(([, , drag]) => drag.clientX)).toEqual([
      110, 120,
    ]);
    expect(onDragEnd.mock.calls).toEqual([["clip-1", "fade-out", true]]);
  });
});

describe("Clip body drag", () => {
  it("moves on a drag, and the click that follows does not select", () => {
    const { onSelect, onDragStart, onDrag, onDragEnd } = setup();
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 50, clientY: 20 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 80, clientY: 20 });
    fireEvent.pointerUp(body(), { pointerId: 1, clientX: 80 });
    fireEvent.click(body());
    expect(onDragStart.mock.calls).toEqual([
      [
        "clip-1",
        "move",
        { clientX: 80, clientY: 20, shift: false, alt: false },
      ],
    ]);
    expect(onDrag.mock.calls).toEqual([
      [
        "clip-1",
        "move",
        { clientX: 80, clientY: 20, dx: 30, dy: 0, shift: false, alt: false },
      ],
    ]);
    expect(onDragEnd.mock.calls).toEqual([["clip-1", "move", true]]);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(body());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("starts a move on a mostly vertical drag, which is how a clip changes lane", () => {
    const { onDragStart, onDrag } = setup();
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 50, clientY: 20 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 52, clientY: 110 });
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDrag.mock.calls[0][2]).toMatchObject({ dx: 2, dy: 90 });
  });

  it("drops the press when the host refuses the start, and reports nothing more", () => {
    const refuse = vi.fn(() => false);
    const { onDrag, onDragEnd } = setup({ onDragStart: refuse });
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 50 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 80 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 120 });
    fireEvent.pointerUp(body(), { pointerId: 1, clientX: 120 });
    expect(refuse).toHaveBeenCalledTimes(1);
    expect(onDrag).not.toHaveBeenCalled();
    expect(onDragEnd).not.toHaveBeenCalled();
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

  it("ignores a move from another pointer or a press with the right button", () => {
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

describe("Clip under a finger", () => {
  const swipe = (target: HTMLElement) => {
    fireEvent.pointerDown(target, {
      pointerId: 5,
      pointerType: "touch",
      clientX: 50,
    });
    fireEvent.pointerMove(target, {
      pointerId: 5,
      pointerType: "touch",
      clientX: 120,
    });
    fireEvent.pointerUp(target, {
      pointerId: 5,
      pointerType: "touch",
      clientX: 120,
    });
  };

  it("does not grab an unselected clip, so the swipe is the browser's to pan with, and a tap still selects", () => {
    const { onDragStart, onDrag, onSelect } = setup();
    swipe(body());
    fireEvent.click(body());
    expect(onDragStart).not.toHaveBeenCalled();
    expect(onDrag).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("moves a selected clip under one finger", () => {
    const { onDragStart, onDragEnd } = setup({ selected: true });
    swipe(body());
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragEnd.mock.calls).toEqual([["clip-1", "move", true]]);
  });

  it("does not grab a handle of a clip that is not selected", () => {
    const { handle, onDragStart } = setup();
    swipe(handle("Trim end"));
    expect(onDragStart).not.toHaveBeenCalled();
  });
});

describe("Clip when the grabbed handle goes away mid-drag", () => {
  const touch = (pointerId: number, clientX: number) => ({
    pointerId,
    pointerType: "touch",
    clientX,
  });

  it("ends the drag once when edit rights are lost, and takes a new finger afterwards", () => {
    const { handle, onDragEnd, onDrag, rerender } = setup({ selected: true });
    fireEvent.pointerDown(handle("Trim end"), touch(5, 50));
    fireEvent.pointerMove(handle("Trim end"), touch(5, 120));
    expect(onDrag).toHaveBeenCalledTimes(1);
    rerender(
      <Clip
        {...base}
        selected
        readOnly
        onDragEnd={onDragEnd}
        onDrag={onDrag}
      />,
    );
    expect(onDragEnd.mock.calls).toEqual([["clip-1", "trim-out", false]]);
    rerender(<Clip {...base} selected onDragEnd={onDragEnd} onDrag={onDrag} />);
    fireEvent.pointerDown(handle("Trim end"), touch(6, 50));
    fireEvent.pointerMove(handle("Trim end"), touch(6, 120));
    fireEvent.pointerUp(handle("Trim end"), touch(6, 120));
    expect(onDrag).toHaveBeenCalledTimes(2);
    expect(onDragEnd.mock.calls).toEqual([
      ["clip-1", "trim-out", false],
      ["clip-1", "trim-out", true],
    ]);
  });

  it("ends a fade drag once when the clip narrows below the fade handles", () => {
    const { handle, onDragEnd, rerender } = setup({ selected: true });
    fireEvent.pointerDown(handle("Fade in"), touch(5, 50));
    fireEvent.pointerMove(handle("Fade in"), touch(5, 120));
    rerender(
      <Clip
        {...base}
        selected
        duration={CLIP_NARROW_WIDTH / base.pxPerSecond - 0.1}
        onDragEnd={onDragEnd}
      />,
    );
    expect(onDragEnd.mock.calls).toEqual([["clip-1", "fade-in", false]]);
  });
});

describe("Clip as a guest sees it", () => {
  it("has no handles and cannot be dragged by a mouse or a finger, but can be selected", async () => {
    const user = userEvent.setup();
    const { onSelect, onDragStart } = setup({ readOnly: true, selected: true });
    expect(screen.queryByRole("slider")).toBeNull();
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 50 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 90 });
    fireEvent.pointerUp(body(), { pointerId: 1, clientX: 90 });
    fireEvent.pointerDown(body(), {
      pointerId: 2,
      pointerType: "touch",
      clientX: 50,
    });
    fireEvent.pointerMove(body(), {
      pointerId: 2,
      pointerType: "touch",
      clientX: 90,
    });
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
