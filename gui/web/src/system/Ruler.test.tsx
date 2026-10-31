import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { FakeResizeObserver, stubResizeObserver } from "../test/resizeObserver";
import { Ruler, type RulerProps } from "./Ruler";

const base: RulerProps = {
  start: 604,
  pxPerSecond: 40,
  width: 360,
  duration: 3130,
  playhead: 608.5,
  onSeek: () => undefined,
};

function setup(over: Partial<RulerProps> = {}) {
  const handlers = {
    onSeek: vi.fn(),
    onFit: vi.fn(),
    onScrubStart: vi.fn(),
    onScrub: vi.fn(),
    onScrubEnd: vi.fn(),
    onSelectionDragStart: vi.fn(),
    onSelectionDrag: vi.fn(),
    onSelectionDragEnd: vi.fn(),
    onSelectionNudge: vi.fn(),
    onSelectionNudgeEnd: vi.fn(),
  };
  const view = render(<Ruler {...base} {...handlers} {...over} />);
  const handle = (edge: "start" | "end") =>
    screen.getByRole("slider", { name: `Selection ${edge}` });
  return { ...handlers, ...view, handle };
}

const body = () => screen.getByRole("slider", { name: "Timeline position" });
const selection = { start: 606, end: 610 };
const labels = (container: HTMLElement) =>
  [...container.querySelectorAll(".sys-ruler-tick")].map((t) => t.textContent);

describe("Ruler drawing", () => {
  it("is a slider named for the playhead, inside a group, with the time as its text", () => {
    setup();
    expect(screen.getByRole("group", { name: "Time ruler" })).toBeVisible();
    expect(body()).toHaveAttribute("aria-valuemin", "0");
    expect(body()).toHaveAttribute("aria-valuemax", "3130");
    expect(body()).toHaveAttribute("aria-valuenow", "608.5");
    expect(body()).toHaveAttribute("aria-valuetext", "10:08.5");
    expect(body()).toHaveAttribute("tabindex", "0");
  });

  it("leaves the needle to a host that hides it, while the value and the keys still follow the playhead", () => {
    const { container, onSeek } = setup({
      hidePlayhead: true,
      playhead: 608.5,
    });
    expect(container.querySelector(".sys-ruler-playhead")).toBeNull();
    expect(body()).toHaveAttribute("aria-valuenow", "608.5");
    fireEvent.keyDown(body(), { key: "ArrowRight" });
    expect(onSeek).toHaveBeenCalledWith(610.5);
  });

  it("clamps the slider's text to the episode like its value", () => {
    setup({ duration: 0, playhead: 10 });
    expect(body()).toHaveAttribute("aria-valuenow", "0");
    expect(body()).toHaveAttribute("aria-valuetext", "0:00.0");
  });

  it("labels the window at the smallest nice step that keeps labels 64 px apart", () => {
    const { container, rerender } = setup();
    expect(labels(container)).toEqual([
      "10:04",
      "10:06",
      "10:08",
      "10:10",
      "10:12",
    ]);
    rerender(<Ruler {...base} pxPerSecond={400} start={604} />);
    expect(labels(container)).toEqual([
      "10:04.0",
      "10:04.2",
      "10:04.4",
      "10:04.6",
      "",
    ]);
    rerender(<Ruler {...base} pxPerSecond={0.5} start={0} />);
    expect(labels(container)).toEqual(["0:00", "5:00", "10:00"]);
  });

  it("flags the tick whose label would pass the right edge so the label sits left of its line", () => {
    const { container } = setup({ start: 0, pxPerSecond: 12, duration: 36 });
    const ticks = [...container.querySelectorAll(".sys-ruler-tick")];
    expect(ticks.map((t) => t.getAttribute("data-align"))).toEqual([
      null,
      null,
      null,
      "end",
    ]);
    expect(ticks.at(-1)).toHaveTextContent("0:30");
  });

  it("drops the label before the end label at a 320 px phone's 256 px, so none touch", () => {
    const { container } = setup({
      start: 0,
      pxPerSecond: 256 / 60,
      width: 256,
      duration: 60,
    });
    expect(labels(container)).toEqual(["0:00", "0:15", "0:30", "", "1:00"]);
  });

  it("spaces labels by the root font size, not by px: at 200% it takes a coarser step and keeps the end label", () => {
    const root = document.documentElement;
    const was = root.style.fontSize;
    root.style.fontSize = "32px";
    try {
      const { container } = setup({
        start: 0,
        pxPerSecond: 256 / 60,
        width: 256,
        duration: 60,
      });
      const shown = labels(container).filter(Boolean);
      expect(shown).toEqual(["0:00", "1:00"]);
      const ticks = [...container.querySelectorAll(".sys-ruler-tick")];
      expect(ticks.at(-1)).toHaveAttribute("data-align", "end");
    } finally {
      root.style.fontSize = was;
    }
  });

  it("re-thins the labels when the root font size changes after mount", () => {
    stubResizeObserver();
    const root = document.documentElement;
    const was = root.style.fontSize;
    try {
      const { container } = setup({
        start: 0,
        pxPerSecond: 256 / 60,
        width: 256,
        duration: 60,
      });
      expect(labels(container).filter(Boolean)).toEqual([
        "0:00",
        "0:15",
        "0:30",
        "1:00",
      ]);
      const probe = container.querySelector<HTMLElement>(
        '.sys-ruler > [aria-hidden="true"][style*="1rem"]',
      );
      expect(probe).not.toBeNull();
      root.style.fontSize = "32px";
      act(() => FakeResizeObserver.of(probe as Element).fire(probe as Element));
      expect(labels(container).filter(Boolean)).toEqual(["0:00", "1:00"]);
      root.style.fontSize = was;
      act(() => FakeResizeObserver.of(probe as Element).fire(probe as Element));
      expect(labels(container).filter(Boolean)).toHaveLength(4);
    } finally {
      root.style.fontSize = was;
      vi.unstubAllGlobals();
    }
  });

  it("re-thins the labels when the window resizes after the root font size changes", () => {
    stubResizeObserver();
    const root = document.documentElement;
    const was = root.style.fontSize;
    try {
      const { container } = setup({
        start: 0,
        pxPerSecond: 256 / 60,
        width: 256,
        duration: 60,
      });
      expect(labels(container).filter(Boolean)).toHaveLength(4);
      root.style.fontSize = "32px";
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      expect(labels(container).filter(Boolean)).toEqual(["0:00", "1:00"]);
    } finally {
      root.style.fontSize = was;
      vi.unstubAllGlobals();
    }
  });

  it("reads the root font size once while the ruler redraws", () => {
    stubResizeObserver();
    const real = window.getComputedStyle.bind(window);
    const rootReads = vi.fn();
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (el: Element, pseudo?: string | null) => {
        if (el === document.documentElement) rootReads();
        return real(el, pseudo);
      },
    );
    try {
      const { rerender } = setup();
      const afterMount = rootReads.mock.calls.length;
      for (const playhead of [610, 612, 614]) {
        rerender(<Ruler {...base} playhead={playhead} />);
      }
      expect(rootReads.mock.calls.length).toBe(afterMount);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("places the playhead, the selection band and the sessions in pixels of the window", () => {
    const { container } = setup({
      selection,
      sessions: [
        { start: 600, end: 607, label: "S1" },
        { start: 607, end: 612, label: "S2" },
      ],
    });
    const style = (selector: string) =>
      container.querySelector<HTMLElement>(selector)?.style;
    expect(
      style(".sys-ruler-playhead")?.getPropertyValue("--sys-ruler-x"),
    ).toBe("180px");
    expect(
      style(".sys-ruler-selection")?.getPropertyValue("--sys-ruler-x"),
    ).toBe("80px");
    expect(
      style(".sys-ruler-selection")?.getPropertyValue("--sys-ruler-w"),
    ).toBe("160px");
    const sessions = [
      ...container.querySelectorAll<HTMLElement>(".sys-ruler-session"),
    ];
    expect(
      sessions.map((s) => [
        s.style.getPropertyValue("--sys-ruler-x"),
        s.style.getPropertyValue("--sys-ruler-w"),
        s.textContent,
        s.hasAttribute("data-odd"),
      ]),
    ).toEqual([
      ["0px", "120px", "S1", false],
      ["120px", "200px", "S2", true],
    ]);
  });

  it("draws neither a playhead nor a handle that is off the window", () => {
    const { container } = setup({
      playhead: 100,
      selection: { start: 100, end: 200 },
    });
    expect(container.querySelector(".sys-ruler-playhead")).toBeNull();
    expect(screen.queryByRole("slider", { name: /^Selection/ })).toBeNull();
    expect(container.querySelector(".sys-ruler-selection")).toBeNull();
  });

  it("has no axe violations with a selection", async () => {
    const { container } = setup({ selection });
    await expectNoA11yViolations(container);
  });
});

describe("Ruler seeking", () => {
  it("seeks to the time under a click, held to the episode", () => {
    const { onSeek } = setup();
    fireEvent.click(body(), { clientX: 100 });
    fireEvent.click(body(), { clientX: -99999 });
    fireEvent.click(body(), { clientX: 99999999 });
    expect(onSeek.mock.calls).toEqual([[606.5], [0], [3130]]);
  });

  it("fits on a double-click without passing the event on", () => {
    const { onFit } = setup();
    fireEvent.doubleClick(body());
    expect(onFit.mock.calls).toEqual([[]]);
  });

  it("a guest still seeks and scrubs", () => {
    const { onSeek, onScrub } = setup({ readOnly: true, selection });
    fireEvent.click(body(), { clientX: 40 });
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 40 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 80 });
    expect(onSeek.mock.calls).toEqual([[605]]);
    expect(onScrub.mock.calls.map(([seconds]) => seconds)).toEqual([606]);
  });
});

describe("Ruler scrubbing", () => {
  it("starts after 3 px for a mouse, reports each time under the pointer, and ends committed", () => {
    const { onScrubStart, onScrub, onScrubEnd, onSeek } = setup();
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 40 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 42 });
    expect(onScrubStart).not.toHaveBeenCalled();
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 80, altKey: true });
    fireEvent.pointerMove(body(), {
      pointerId: 1,
      clientX: 120,
      shiftKey: true,
    });
    fireEvent.pointerUp(body(), { pointerId: 1, clientX: 120 });
    fireEvent.click(body(), { clientX: 120, detail: 1 });
    expect(onScrubStart.mock.calls).toEqual([
      [606, { clientX: 80, clientY: 0, shift: false, alt: true }],
    ]);
    expect(onScrub.mock.calls).toEqual([
      [
        606,
        { clientX: 80, clientY: 0, dx: 40, dy: 0, shift: false, alt: true },
      ],
      [
        607,
        { clientX: 120, clientY: 0, dx: 80, dy: 0, shift: true, alt: false },
      ],
    ]);
    expect(onScrubEnd.mock.calls).toEqual([[true]]);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("never scrubs from a finger, so a swipe is left to the browser to pan and a tap still seeks", () => {
    const { onScrubStart, onScrub, onScrubEnd, onSeek } = setup();
    const finger = (clientX: number) => ({
      pointerId: 7,
      pointerType: "touch",
      clientX,
    });
    fireEvent.pointerDown(body(), finger(100));
    fireEvent.pointerMove(body(), finger(112));
    fireEvent.pointerMove(body(), finger(160));
    fireEvent.pointerUp(body(), finger(160));
    expect(onScrubStart).not.toHaveBeenCalled();
    expect(onScrub).not.toHaveBeenCalled();
    expect(onScrubEnd).not.toHaveBeenCalled();
    expect(onSeek).not.toHaveBeenCalled();
    fireEvent.pointerDown(body(), finger(100));
    fireEvent.pointerMove(body(), finger(108));
    fireEvent.pointerUp(body(), finger(108));
    fireEvent.click(body(), { clientX: 108 });
    expect(onScrubStart).not.toHaveBeenCalled();
    expect(onSeek.mock.calls).toEqual([[606.7]]);
  });

  it("lets a pen drag-seek after the mouse's slop", () => {
    const { onScrubStart, onScrub } = setup();
    const pen = (clientX: number) => ({
      pointerId: 8,
      pointerType: "pen",
      clientX,
    });
    fireEvent.pointerDown(body(), pen(100));
    fireEvent.pointerMove(body(), pen(102));
    expect(onScrubStart).not.toHaveBeenCalled();
    fireEvent.pointerMove(body(), pen(110));
    fireEvent.pointerMove(body(), pen(160));
    fireEvent.pointerUp(body(), pen(160));
    expect(onScrubStart).toHaveBeenCalledTimes(1);
    expect(onScrub).toHaveBeenCalled();
  });

  it("does nothing more when the host refuses the scrub, and still ignores the release", () => {
    const { onScrub, onScrubEnd } = setup({ onScrubStart: () => false });
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 40 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 90 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 120 });
    fireEvent.pointerUp(body(), { pointerId: 1, clientX: 120 });
    expect(onScrub).not.toHaveBeenCalled();
    expect(onScrubEnd).not.toHaveBeenCalled();
  });

  it("ignores a second pointer while one has hold", () => {
    const { onScrub, onScrubEnd } = setup();
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 40 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 60 });
    fireEvent.pointerDown(body(), { pointerId: 2, clientX: 300 });
    fireEvent.pointerMove(body(), { pointerId: 2, clientX: 340 });
    fireEvent.pointerUp(body(), { pointerId: 2, clientX: 340 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 80 });
    fireEvent.pointerUp(body(), { pointerId: 1, clientX: 80 });
    expect(onScrub.mock.calls.map(([seconds]) => seconds)).toEqual([
      605.5, 606,
    ]);
    expect(onScrubEnd.mock.calls).toEqual([[true]]);
  });

  it("ends as not committed on pointercancel and on a lost capture, once", () => {
    const { onScrubEnd } = setup();
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 40 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 80 });
    fireEvent.pointerCancel(body(), { pointerId: 1 });
    fireEvent.lostPointerCapture(body(), { pointerId: 1 });
    expect(onScrubEnd.mock.calls).toEqual([[false]]);
  });

  it("takes Escape from the document and takes nothing from the release that follows", () => {
    const { onScrub, onScrubEnd, onSeek } = setup();
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 40 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 80 });
    const handled = fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 120 });
    fireEvent.pointerUp(body(), { pointerId: 1, clientX: 120 });
    fireEvent.click(body(), { clientX: 120, detail: 1 });
    expect(handled).toBe(false);
    expect(onScrubEnd.mock.calls).toEqual([[false]]);
    expect(onScrub).toHaveBeenCalledTimes(1);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("leaves Escape alone before the press has moved", () => {
    setup();
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 40 });
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);
  });

  it("ends as not committed on a window blur and when the ruler leaves the page", () => {
    const first = setup();
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 40 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 80 });
    fireEvent.blur(window);
    expect(first.onScrubEnd.mock.calls).toEqual([[false]]);
    first.unmount();
    const second = setup();
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 40 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 80 });
    second.unmount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(second.onScrubEnd.mock.calls).toEqual([[false]]);
  });

  it("reads a right-button press as nothing", () => {
    const { onScrubStart } = setup();
    fireEvent.pointerDown(body(), {
      pointerId: 1,
      pointerType: "mouse",
      button: 2,
      clientX: 40,
    });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 90 });
    expect(onScrubStart).not.toHaveBeenCalled();
  });
});

describe("Ruler selection handles", () => {
  it("are sliders at the band's ends with the edge as a time and the other edge as a limit", () => {
    const { handle } = setup({ selection });
    expect(handle("start")).toHaveAttribute("aria-valuenow", "606");
    expect(handle("start")).toHaveAttribute("aria-valuemin", "0");
    expect(handle("start")).toHaveAttribute("aria-valuemax", "609.99");
    expect(handle("start")).toHaveAttribute("aria-valuetext", "10:06.000");
    expect(handle("end")).toHaveAttribute("aria-valuemin", "606.01");
    expect(handle("end")).toHaveAttribute("aria-valuemax", "3130");
    expect(handle("end").style.getPropertyValue("--sys-ruler-x")).toBe("240px");
    expect(handle("start")).toHaveAttribute("tabindex", "-1");
  });

  it("report a drag from the first 3 px with the pointer under the edge, and end it on release", () => {
    const {
      handle,
      onSelectionDragStart,
      onSelectionDrag,
      onSelectionDragEnd,
    } = setup({ selection });
    const grip = handle("end");
    fireEvent.pointerDown(grip, { pointerId: 1, clientX: 244, clientY: 10 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 246 });
    expect(onSelectionDragStart).not.toHaveBeenCalled();
    fireEvent.pointerMove(grip, {
      pointerId: 1,
      clientX: 284,
      clientY: 12,
      shiftKey: true,
    });
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 284 });
    fireEvent.click(grip, { clientX: 284, detail: 1 });
    expect(onSelectionDragStart.mock.calls).toEqual([
      ["end", { clientX: 284, clientY: 12, shift: true, alt: false }],
    ]);
    expect(onSelectionDrag.mock.calls).toEqual([
      [
        "end",
        {
          clientX: 284,
          clientY: 12,
          dx: 40,
          dy: 2,
          shift: true,
          alt: false,
          seconds: 611,
        },
      ],
    ]);
    expect(onSelectionDragEnd.mock.calls).toEqual([["end", true]]);
  });

  it("seeks on a tap that never moves instead of swallowing it", () => {
    const { handle, onSeek, onSelectionDragStart } = setup({ selection });
    fireEvent.pointerDown(handle("start"), { pointerId: 1, clientX: 90 });
    fireEvent.pointerUp(handle("start"), { pointerId: 1, clientX: 90 });
    fireEvent.click(handle("start"), { clientX: 90 });
    expect(onSelectionDragStart).not.toHaveBeenCalled();
    expect(onSeek.mock.calls).toEqual([[606.25]]);
  });

  it("let a finger take them from 10 px, and the drag starts at the knob without a jump", () => {
    const { handle, onSelectionDragStart, onSelectionDrag } = setup({
      selection,
    });
    const finger = (clientX: number) => ({
      pointerId: 4,
      pointerType: "touch",
      clientX,
    });
    fireEvent.pointerDown(handle("start"), finger(80));
    fireEvent.pointerMove(handle("start"), finger(84));
    fireEvent.pointerMove(handle("start"), finger(89));
    expect(onSelectionDragStart).not.toHaveBeenCalled();
    fireEvent.pointerMove(handle("start"), finger(90));
    fireEvent.pointerMove(handle("start"), finger(130));
    expect(onSelectionDragStart).toHaveBeenCalledTimes(1);
    expect(
      onSelectionDrag.mock.calls.map(([, drag]) => [drag.dx, drag.seconds]),
    ).toEqual([
      [0, 606],
      [40, 607],
    ]);
  });

  it("end once as committed when a knob dragged out of the window is released anywhere, and the bare mouse then drags nothing", () => {
    const { handle, rerender, onSelectionDrag, onSelectionDragEnd } = setup({
      selection,
    });
    const group = () => screen.getByRole("group", { name: "Time ruler" });
    fireEvent.pointerDown(handle("end"), { pointerId: 1, clientX: 244 });
    fireEvent.pointerMove(handle("end"), { pointerId: 1, clientX: 300 });
    rerender(
      <Ruler
        {...base}
        selection={{ start: 606, end: 700 }}
        onSelectionDrag={onSelectionDrag}
        onSelectionDragEnd={onSelectionDragEnd}
      />,
    );
    expect(screen.queryByRole("slider", { name: "Selection end" })).toBeNull();
    fireEvent.pointerUp(group(), { pointerId: 1, clientX: 700, clientY: 200 });
    expect(onSelectionDragEnd.mock.calls).toEqual([["end", true]]);
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(group(), { pointerId: 1, clientX: 120 });
    expect(onSelectionDrag).toHaveBeenCalledTimes(1);
  });

  it("ends as not committed when the pointer capture is lost off the knob", () => {
    const { handle, onSelectionDragEnd } = setup({ selection });
    const group = screen.getByRole("group", { name: "Time ruler" });
    fireEvent.pointerDown(handle("end"), { pointerId: 1, clientX: 244 });
    fireEvent.pointerMove(handle("end"), { pointerId: 1, clientX: 300 });
    fireEvent.lostPointerCapture(handle("end"), { pointerId: 1 });
    expect(onSelectionDragEnd).not.toHaveBeenCalled();
    fireEvent.lostPointerCapture(group, { pointerId: 1 });
    expect(onSelectionDragEnd.mock.calls).toEqual([["end", false]]);
  });

  it("end as not committed on Escape, a blur, a cancel, a second pointer's absence and the host dropping the selection", () => {
    const { handle, onSelectionDragEnd, rerender, ...rest } = setup({
      selection,
    });
    const press = () => {
      fireEvent.pointerDown(handle("start"), { pointerId: 1, clientX: 80 });
      fireEvent.pointerMove(handle("start"), { pointerId: 1, clientX: 120 });
    };
    press();
    fireEvent.keyDown(document.body, { key: "Escape" });
    press();
    fireEvent.blur(window);
    press();
    fireEvent.pointerCancel(handle("start"), { pointerId: 1 });
    press();
    rerender(
      <Ruler
        {...base}
        {...rest}
        onSelectionDragEnd={onSelectionDragEnd}
        selection={undefined}
      />,
    );
    expect(onSelectionDragEnd.mock.calls).toEqual([
      ["start", false],
      ["start", false],
      ["start", false],
      ["start", false],
    ]);
  });

  it("end as not committed when the ruler becomes read-only mid-drag", () => {
    const { handle, onSelectionDragEnd, rerender, ...rest } = setup({
      selection,
    });
    fireEvent.pointerDown(handle("end"), { pointerId: 1, clientX: 240 });
    fireEvent.pointerMove(handle("end"), { pointerId: 1, clientX: 280 });
    rerender(
      <Ruler
        {...base}
        {...rest}
        onSelectionDragEnd={onSelectionDragEnd}
        selection={selection}
        readOnly
      />,
    );
    expect(onSelectionDragEnd.mock.calls).toEqual([["end", false]]);
  });

  it("end as not committed when the ruler unmounts, and refuse a drag the host refuses", () => {
    const refused = setup({ selection, onSelectionDragStart: () => false });
    fireEvent.pointerDown(refused.handle("end"), {
      pointerId: 1,
      clientX: 240,
    });
    fireEvent.pointerMove(refused.handle("end"), {
      pointerId: 1,
      clientX: 280,
    });
    expect(refused.onSelectionDrag).not.toHaveBeenCalled();
    refused.unmount();
    const view = setup({ selection });
    fireEvent.pointerDown(view.handle("end"), { pointerId: 1, clientX: 240 });
    fireEvent.pointerMove(view.handle("end"), { pointerId: 1, clientX: 280 });
    view.unmount();
    expect(view.onSelectionDragEnd.mock.calls).toEqual([["end", false]]);
  });
});

describe("Ruler keys", () => {
  it("is one tab stop and moves the playhead one tick with Left and Right, ten with Shift", async () => {
    const user = userEvent.setup();
    const { onSeek } = setup({ selection });
    await user.tab();
    expect(body()).toHaveFocus();
    await user.keyboard("{ArrowRight}{ArrowLeft}{Shift>}{ArrowRight}{/Shift}");
    expect(onSeek.mock.calls).toEqual([[610.5], [606.5], [628.5]]);
    await user.tab();
    expect(body()).not.toHaveFocus();
  });

  it("goes to the ends with Home and End and holds to the episode", async () => {
    const user = userEvent.setup();
    const { onSeek, rerender } = setup();
    body().focus();
    await user.keyboard("{Home}{End}");
    rerender(<Ruler {...base} playhead={3129} onSeek={onSeek} />);
    await user.keyboard("{ArrowRight}");
    rerender(<Ruler {...base} playhead={3130} onSeek={onSeek} />);
    await user.keyboard("{ArrowRight}");
    expect(onSeek.mock.calls).toEqual([[0], [3130], [3130]]);
  });

  it("stops the keys it handles and lets every other key and chord reach the keymap", () => {
    setup();
    const seen: string[] = [];
    const listen = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", listen);
    body().focus();
    fireEvent.keyDown(body(), { key: "ArrowRight" });
    fireEvent.keyDown(body(), { key: "Home" });
    fireEvent.keyDown(body(), { key: "ArrowRight", ctrlKey: true });
    fireEvent.keyDown(body(), { key: "ArrowLeft", metaKey: true });
    fireEvent.keyDown(body(), { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(body(), { key: " " });
    fireEvent.keyDown(body(), { key: "ArrowUp" });
    window.removeEventListener("keydown", listen);
    expect(seen).toEqual([
      "ArrowRight",
      "ArrowLeft",
      "ArrowRight",
      " ",
      "ArrowUp",
    ]);
  });

  it("walks focus to the selection handles with Alt, and nudges 10 ms, Shift 100 ms", async () => {
    const user = userEvent.setup();
    const { handle, onSelectionNudge, onSelectionNudgeEnd } = setup({
      selection,
    });
    body().focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(handle("start")).toHaveFocus();
    await user.keyboard("{ArrowLeft}{Shift>}{ArrowRight}{/Shift}");
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(handle("end")).toHaveFocus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(handle("end")).toHaveFocus();
    await user.keyboard("{Alt>}{ArrowLeft}{ArrowLeft}{/Alt}");
    expect(body()).toHaveFocus();
    expect(onSelectionNudge.mock.calls).toEqual([
      ["start", -0.01, { repeat: false }],
      ["start", 0.1, { repeat: false }],
    ]);
    expect(onSelectionNudgeEnd.mock.calls).toEqual([["start"], ["start"]]);
  });

  it("reports a held key as repeat and closes the step on release or when focus leaves", () => {
    const { handle, onSelectionNudge, onSelectionNudgeEnd } = setup({
      selection,
    });
    const grip = handle("start");
    fireEvent.keyDown(grip, { key: "ArrowRight" });
    fireEvent.keyDown(grip, { key: "ArrowRight", repeat: true });
    expect(
      onSelectionNudge.mock.calls.map(([, , nudge]) => nudge.repeat),
    ).toEqual([false, true]);
    fireEvent.keyUp(grip, { key: "ArrowRight" });
    fireEvent.keyUp(grip, { key: "ArrowRight" });
    fireEvent.keyDown(grip, { key: "ArrowLeft" });
    fireEvent.blur(grip);
    expect(onSelectionNudgeEnd.mock.calls).toEqual([["start"], ["start"]]);
  });

  it("does not walk to handles that are not there", async () => {
    const user = userEvent.setup();
    const { onSeek } = setup({ selection, readOnly: true });
    body().focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(body()).toHaveFocus();
    expect(onSeek).not.toHaveBeenCalled();
  });
});

describe("Ruler passthrough", () => {
  it("puts the anchor on the root and the hit attributes on the body and the handles", () => {
    const { container, handle } = setup({
      selection,
      anchorProps: { "data-presence-anchor": "ruler" },
      hitProps: {
        scrub: { "data-hit-kind": "ruler" },
        end: { "data-hit-kind": "range-end" },
      },
    });
    expect(container.querySelector(".sys-ruler")).toHaveAttribute(
      "data-presence-anchor",
      "ruler",
    );
    expect(body()).toHaveAttribute("data-hit-kind", "ruler");
    expect(handle("end")).toHaveAttribute("data-hit-kind", "range-end");
    expect(handle("start")).not.toHaveAttribute("data-hit-kind");
  });
});

describe("Ruler drag limits", () => {
  const seconds = (calls: unknown[][]) =>
    calls.map(([, drag]) => (drag as { seconds: number }).seconds);
  const drag = (
    handle: HTMLElement,
    from: number,
    to: number[],
    pointerId = 1,
  ) => {
    fireEvent.pointerDown(handle, { pointerId, clientX: from });
    for (const clientX of to) {
      fireEvent.pointerMove(handle, { pointerId, clientX });
    }
  };

  it("holds the start knob a hair before the end knob and the end knob a hair after the start knob", () => {
    const { handle, onSelectionDrag } = setup({ selection });
    const group = screen.getByRole("group", { name: "Time ruler" });
    drag(handle("start"), 80, [90, 340]);
    fireEvent.pointerUp(group, { pointerId: 1, clientX: 340 });
    drag(handle("end"), 240, [250, 0], 2);
    expect(seconds(onSelectionDrag.mock.calls)).toEqual([
      606.25, 609.99, 610.25, 606.01,
    ]);
  });

  it("holds a knob dragged off the episode to its ends, whichever way the release lands", () => {
    const { handle, onSelectionDrag, onSelectionDragEnd } = setup({
      start: 0,
      pxPerSecond: 20,
      duration: 12,
      selection: { start: 2, end: 10 },
    });
    const group = screen.getByRole("group", { name: "Time ruler" });
    drag(handle("start"), 40, [50, -300]);
    fireEvent.pointerUp(group, { pointerId: 1, clientX: -500 });
    drag(handle("end"), 200, [210, 900], 2);
    fireEvent.pointerUp(group, { pointerId: 2, clientX: 1400 });
    expect(seconds(onSelectionDrag.mock.calls)).toEqual([2.5, 0, 10.5, 12]);
    expect(onSelectionDragEnd.mock.calls).toEqual([
      ["start", true],
      ["end", true],
    ]);
  });
});

describe("Ruler keys during a drag", () => {
  const SWALLOWED = ["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "];

  it("ignores the playhead keys while a scrub is moving, keeps Escape live, and works again after", () => {
    const { onSeek, onScrubEnd } = setup();
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 140 });
    for (const key of SWALLOWED) {
      expect(fireEvent.keyDown(body(), { key })).toBe(false);
    }
    expect(onSeek).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(body(), { key: "Escape" })).toBe(false);
    expect(onScrubEnd.mock.calls).toEqual([[false]]);
    fireEvent.keyDown(body(), { key: "ArrowRight" });
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("ignores the nudge keys on a knob while it is moving, still walks focus with Alt, and nudges after the release", () => {
    const { handle, onSelectionNudge, onSelectionDragEnd } = setup({
      selection,
    });
    const group = screen.getByRole("group", { name: "Time ruler" });
    fireEvent.pointerDown(handle("start"), { pointerId: 1, clientX: 80 });
    fireEvent.pointerMove(handle("start"), { pointerId: 1, clientX: 120 });
    for (const key of SWALLOWED) {
      expect(fireEvent.keyDown(handle("start"), { key })).toBe(false);
    }
    expect(onSelectionNudge).not.toHaveBeenCalled();
    fireEvent.keyDown(handle("start"), { key: "ArrowRight", altKey: true });
    expect(handle("end")).toHaveFocus();
    fireEvent.pointerUp(group, { pointerId: 1, clientX: 120 });
    expect(onSelectionDragEnd.mock.calls).toEqual([["start", true]]);
    fireEvent.keyDown(handle("start"), { key: "ArrowRight" });
    expect(onSelectionNudge).toHaveBeenCalledTimes(1);
  });

  it("still acts on a key while a press has not passed the slop, and keeps the click after a drag", () => {
    const { onSeek } = setup();
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 100 });
    fireEvent.keyDown(body(), { key: "ArrowRight" });
    expect(onSeek).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(body(), { pointerId: 1, clientX: 100 });
    fireEvent.pointerDown(body(), { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(body(), { pointerId: 1, clientX: 140 });
    fireEvent.pointerUp(body(), { pointerId: 1, clientX: 140 });
    fireEvent.click(body(), { detail: 1, clientX: 140 });
    expect(onSeek).toHaveBeenCalledTimes(1);
    fireEvent.click(body(), { detail: 0, clientX: 140 });
    expect(onSeek).toHaveBeenCalledTimes(2);
  });
});
