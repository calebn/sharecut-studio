import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { Envelope, type EnvelopeProps } from "./Envelope";

const POINTS = [
  { id: "a", time: 1, db: 0 },
  { id: "b", time: 4, db: -6 },
  { id: "c", time: 7.2, db: -3 },
  { id: "d", time: 10, db: -12 },
];

const base: EnvelopeProps = {
  points: POINTS,
  trackName: "Maya",
  colorIndex: 0,
  start: 0,
  pxPerSecond: 24,
  width: 360,
  duration: 60,
  onSelect: () => undefined,
};

function setup(over: Partial<EnvelopeProps> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    onMove: vi.fn(),
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
    onNudgeEnd: vi.fn(),
  };
  const props = { ...base, ...handlers, ...over };
  const view = render(<Envelope {...props} />);
  const again = (next: Partial<EnvelopeProps>) =>
    view.rerender(<Envelope {...props} {...next} />);
  return { ...handlers, ...view, again };
}

const point = (place: number) =>
  screen.getByRole("slider", { name: `Envelope point ${place}` });
const group = () =>
  screen.getByRole("group", { name: "Volume envelope, Maya" });
const band = (container: HTMLElement) => {
  const el = container.querySelector(".sys-env-band");
  if (!el) throw new Error("No band");
  return el;
};
const mouse = (clientX: number, clientY: number, pointerId = 1) => ({
  pointerId,
  pointerType: "mouse",
  button: 0,
  clientX,
  clientY,
});

describe("Envelope drawing", () => {
  it("is a group named for the track, with the line hidden from assistive tech", () => {
    const { container } = setup();
    expect(group()).toBeVisible();
    expect(container.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("draws nothing when it is not shown and there are no points", () => {
    const { container, again } = setup({ points: [] });
    expect(container.querySelector(".sys-env")).toBeNull();
    again({ visible: true });
    expect(group()).toBeVisible();
    again({ visible: false, points: POINTS });
    expect(group()).toBeVisible();
  });

  it("draws the unity line at 0 dB, 7.55 px down a 72 px lane, with no points", () => {
    const { container } = setup({ points: [], visible: true });
    expect(container.querySelector(".sys-env-line")).toHaveAttribute(
      "d",
      "M0 7.55L360 7.55",
    );
    expect(group().style.getPropertyValue("--sys-env-zero-y")).toBe("7.55px");
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
  });

  it("draws a dot for each point at its time and level, in time order", () => {
    setup();
    expect(point(2).style.getPropertyValue("--sys-env-x")).toBe("96px");
    expect(point(2).style.getPropertyValue("--sys-env-y")).toBe("13.59px");
    expect(point(3).style.getPropertyValue("--sys-env-x")).toBe("172.8px");
  });

  it("is a slider of the level whose text carries the time", () => {
    setup();
    expect(point(2)).toHaveAttribute("aria-valuemin", "-60");
    expect(point(2)).toHaveAttribute("aria-valuemax", "3.52");
    expect(point(2)).toHaveAttribute("aria-valuenow", "-6");
    expect(point(2)).toHaveAttribute("aria-valuetext", "−6.0 dB at 0:04.00");
  });

  it("draws no dot for a point more than 6 px outside the window", () => {
    setup({ start: 5 });
    expect(screen.getAllByRole("slider")).toHaveLength(2);
    expect(
      screen.queryByRole("slider", { name: "Envelope point 3" }),
    ).not.toBeNull();
  });

  it("sizes the hit areas 16 px, 44 px coarse, and by half the gap beside a near neighbour", () => {
    setup({
      width: 600,
      points: [
        { id: "a", time: 1, db: 0 },
        { id: "b", time: 1.5, db: 0 },
        { id: "c", time: 20, db: 0 },
      ],
    });
    expect(point(1).style.getPropertyValue("--sys-env-fine")).toBe("12px");
    expect(point(1).style.getPropertyValue("--sys-env-coarse")).toBe("12px");
    expect(point(3).style.getPropertyValue("--sys-env-fine")).toBe("16px");
    expect(point(3).style.getPropertyValue("--sys-env-coarse")).toBe("44px");
  });

  it("marks the selected point and the touch and guest forms", () => {
    const { again } = setup({ selected: "c" });
    expect(point(3)).toHaveAttribute("data-selected", "true");
    expect(point(3)).toHaveAttribute("aria-current", "true");
    expect(point(2)).not.toHaveAttribute("aria-current");
    again({ touch: true, readOnly: true });
    expect(group()).toHaveAttribute("data-touch", "true");
    expect(group()).toHaveAttribute("data-readonly", "true");
    expect(point(2)).toHaveAttribute("aria-readonly", "true");
  });

  it("has no accessibility violations, drawn or read-only", async () => {
    const { container, again } = setup({ selected: "b" });
    await expectNoA11yViolations(container);
    again({ readOnly: true });
    await expectNoA11yViolations(container);
  });
});

describe("Envelope focus", () => {
  it("is one tab stop: the selected point, else the first", () => {
    const { again } = setup();
    expect(
      screen.getAllByRole("slider").map((el) => el.getAttribute("tabindex")),
    ).toEqual(["0", "-1", "-1", "-1"]);
    again({ selected: "c" });
    expect(
      screen.getAllByRole("slider").map((el) => el.getAttribute("tabindex")),
    ).toEqual(["-1", "-1", "0", "-1"]);
  });

  it("walks to the next and previous point with Alt and the arrows, even for a guest", async () => {
    const user = userEvent.setup();
    setup({ readOnly: true });
    point(1).focus();
    await user.keyboard("{Alt>}{ArrowRight}{ArrowRight}{/Alt}");
    expect(point(3)).toHaveFocus();
    await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(point(2)).toHaveFocus();
  });
});

describe("Envelope selecting", () => {
  it("selects on a click, Enter and Space, by id", async () => {
    const user = userEvent.setup();
    const { onSelect } = setup({ readOnly: true });
    await user.click(point(2));
    point(3).focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onSelect.mock.calls).toEqual([["b"], ["c"], ["c"]]);
  });
});

describe("Envelope adding", () => {
  it("adds at the click's time and level, to a tenth of a dB", () => {
    const { container, onAdd } = setup();
    fireEvent.click(band(container), { clientX: 120, clientY: 30, detail: 1 });
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(5, -22.3);
  });

  it("holds the time to the episode", () => {
    const { container, onAdd } = setup({ duration: 8 });
    fireEvent.click(band(container), { clientX: 350, clientY: 7, detail: 1 });
    expect(onAdd).toHaveBeenCalledWith(8, 0.5);
  });

  it("does not add for a guest", () => {
    const { container, onAdd } = setup({ readOnly: true });
    fireEvent.click(band(container), { clientX: 120, clientY: 30, detail: 1 });
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("refuses a time within a millisecond of a point", () => {
    const { container, onAdd } = setup();
    fireEvent.click(band(container), { clientX: 96, clientY: 30, detail: 1 });
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("announces the add once, politely", () => {
    const { container } = setup();
    fireEvent.click(band(container), { clientX: 120, clientY: 10, detail: 1 });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Added envelope point at 0:05.00, −2.4 dB",
    );
  });
});

describe("Envelope after an aborted gesture", () => {
  it("adds on the first click on the line after a drag that ended off a point", () => {
    const { container, onAdd } = setup();
    fireEvent.pointerDown(point(2), mouse(96, 20));
    fireEvent.pointerMove(point(2), mouse(136, 20));
    fireEvent.pointerUp(group(), mouse(136, 20));
    fireEvent.pointerDown(band(container), mouse(120, 30));
    fireEvent.click(band(container), { clientX: 120, clientY: 30, detail: 1 });
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("adds on the first click on the line after Escape aborted a drag", () => {
    const { container, onAdd, onDragEnd } = setup();
    fireEvent.pointerDown(point(2), mouse(96, 20));
    fireEvent.pointerMove(point(2), mouse(136, 20));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDragEnd).toHaveBeenCalledWith("b", false);
    fireEvent.pointerDown(band(container), mouse(120, 30));
    fireEvent.click(band(container), { clientX: 120, clientY: 30, detail: 1 });
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("selects on the first click on a point after a blur aborted a drag", () => {
    const { onSelect } = setup({ selected: "b" });
    fireEvent.pointerDown(point(2), mouse(96, 20));
    fireEvent.pointerMove(point(2), mouse(136, 20));
    fireEvent.blur(window);
    onSelect.mockClear();
    fireEvent.pointerDown(point(3), mouse(172, 20));
    fireEvent.pointerUp(point(3), mouse(172, 20));
    fireEvent.click(point(3), { detail: 1 });
    expect(onSelect).toHaveBeenCalledWith("c");
  });
});

describe("Envelope dragging", () => {
  it("starts past the slop, selects the point, and reports each move with the readout", () => {
    const { onDragStart, onMove, onSelect, container } = setup();
    fireEvent.pointerDown(point(2), mouse(96, 20));
    fireEvent.pointerMove(point(2), mouse(98, 20));
    expect(onDragStart).not.toHaveBeenCalled();
    fireEvent.pointerMove(point(2), mouse(120, 30));
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("b");
    // dx 24 outweighs dy 10: the drag locks to time and never touches the level.
    expect(onMove).toHaveBeenLastCalledWith("b", { timeSeconds: 5 });
    expect(container.querySelector(".sys-readout")).toHaveTextContent(
      "−6.0 dB · 0:05.0",
    );
    expect(point(2)).toHaveAttribute("data-dragging", "true");
    expect(point(2)).toHaveAttribute("aria-valuetext", "−6.0 dB at 0:05.00");
  });

  it("reports the level of a drag that went mostly down", () => {
    const { onMove, container } = setup();
    fireEvent.pointerDown(point(2), mouse(96, 20));
    fireEvent.pointerMove(point(2), mouse(100, 36));
    expect(onMove).toHaveBeenLastCalledWith("b", { db: -21.9 });
    expect(container.querySelector(".sys-readout")).toHaveTextContent(
      "−21.9 dB · 0:04.0",
    );
  });

  it("commits on release and announces it once", () => {
    const { onDragEnd } = setup();
    fireEvent.pointerDown(point(2), mouse(96, 20));
    fireEvent.pointerMove(point(2), mouse(120, 20));
    fireEvent.pointerUp(point(2), mouse(120, 20));
    expect(onDragEnd).toHaveBeenCalledWith("b", true);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Envelope point at 0:05.0",
    );
  });

  it("stops a millisecond before the neighbour and says limit", () => {
    const { onMove, container } = setup();
    fireEvent.pointerDown(point(2), mouse(96, 20));
    fireEvent.pointerMove(point(2), mouse(5000, 20));
    expect(onMove).toHaveBeenLastCalledWith("b", { timeSeconds: 7.199 });
    expect(container.querySelector(".sys-readout-limit")).not.toBeNull();
  });

  it("holds the level to -60 and +3.5 dB", () => {
    const { onMove } = setup();
    fireEvent.pointerDown(point(2), mouse(96, 20));
    fireEvent.pointerMove(point(2), mouse(96, 5000));
    expect(onMove).toHaveBeenLastCalledWith("b", { db: -60 });
    fireEvent.pointerMove(point(2), mouse(96, -5000));
    expect(onMove).toHaveBeenLastCalledWith("b", { db: 3.5 });
  });

  it("never sends the level for a time drag, however the pointer wobbles, and the reverse", () => {
    const { onMove } = setup();
    fireEvent.pointerDown(point(2), mouse(96, 20));
    fireEvent.pointerMove(point(2), mouse(120, 20));
    fireEvent.pointerMove(point(2), mouse(130, 23));
    fireEvent.pointerMove(point(2), mouse(140, 15));
    fireEvent.pointerUp(point(2), mouse(140, 15));
    for (const [, change] of onMove.mock.calls) {
      expect(Object.keys(change)).toEqual(["timeSeconds"]);
    }
    onMove.mockClear();
    fireEvent.pointerDown(point(2), mouse(96, 20, 2));
    fireEvent.pointerMove(point(2), mouse(96, 36, 2));
    fireEvent.pointerMove(point(2), mouse(103, 40, 2));
    for (const [, change] of onMove.mock.calls) {
      expect(Object.keys(change)).toEqual(["db"]);
    }
    expect(onMove).toHaveBeenCalledTimes(2);
  });

  it("keeps the locked axis exact: back at the start it sends the start value, unrounded", () => {
    const { onMove } = setup({
      points: [
        { id: "a", time: 12.34567, db: -1.938 },
        { id: "b", time: 20, db: -3.0123 },
      ],
      duration: 60,
    });
    fireEvent.pointerDown(point(1), mouse(300, 20));
    fireEvent.pointerMove(point(1), mouse(330, 20));
    expect(onMove).toHaveBeenLastCalledWith("a", { timeSeconds: 13.596 });
    fireEvent.pointerMove(point(1), mouse(300, 20));
    expect(onMove).toHaveBeenLastCalledWith("a", { timeSeconds: 12.34567 });
    fireEvent.pointerUp(point(1), mouse(300, 20));
    fireEvent.pointerDown(point(1), mouse(300, 20, 2));
    fireEvent.pointerMove(point(1), mouse(300, 50, 2));
    fireEvent.pointerMove(point(1), mouse(300, 20, 2));
    expect(onMove).toHaveBeenLastCalledWith("a", { db: -1.938 });
  });

  it("lets a merging host return to the start: out and back leaves the point where it began", () => {
    const { onMove } = setup();
    let held = { time: 4, db: -6 };
    onMove.mockImplementation((_id, change) => {
      held = {
        time: change.timeSeconds ?? held.time,
        db: change.db ?? held.db,
      };
    });
    fireEvent.pointerDown(point(2), mouse(96, 20));
    fireEvent.pointerMove(point(2), mouse(96, 50));
    expect(held.db).not.toBe(-6);
    fireEvent.pointerMove(point(2), mouse(96, 20));
    expect(held).toEqual({ time: 4, db: -6 });
  });

  it("waits for a finger to be 3 px past the slop before it picks an axis, then holds it", () => {
    const { onMove } = setup();
    const finger = (x: number, y: number) => ({
      ...mouse(x, y, 5),
      pointerType: "touch",
    });
    fireEvent.pointerDown(point(2), finger(96, 20));
    fireEvent.pointerMove(point(2), finger(96, 24));
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.pointerMove(point(2), finger(96, 25));
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.pointerMove(point(2), finger(96, 28));
    expect(onMove).toHaveBeenLastCalledWith("b", { db: expect.any(Number) });
    fireEvent.pointerMove(point(2), finger(140, 28));
    expect(onMove).toHaveBeenLastCalledWith("b", { db: expect.any(Number) });
  });

  it("says limit only for the axis it moves", () => {
    const { container } = setup({
      points: [
        { id: "a", time: 1, db: -60 },
        { id: "b", time: 4, db: 3.52 },
      ],
    });
    fireEvent.pointerDown(point(1), mouse(24, 20));
    fireEvent.pointerMove(point(1), mouse(40, 20));
    expect(container.querySelector(".sys-readout-limit")).toBeNull();
    fireEvent.pointerUp(point(1), mouse(40, 20));
    fireEvent.pointerDown(point(2), mouse(96, 20, 2));
    fireEvent.pointerMove(point(2), mouse(96, 0, 2));
    expect(container.querySelector(".sys-readout-limit")).not.toBeNull();
  });

  it("ends uncommitted on Escape without the keymap seeing it, and on a blur", () => {
    const { onDragEnd } = setup();
    const seen: string[] = [];
    const listen = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", listen);
    fireEvent.pointerDown(point(2), mouse(96, 20));
    fireEvent.pointerMove(point(2), mouse(120, 20));
    fireEvent.keyDown(point(2), { key: "Escape" });
    window.removeEventListener("keydown", listen);
    expect(onDragEnd).toHaveBeenCalledWith("b", false);
    expect(seen).toEqual([]);
    fireEvent.pointerDown(point(3), mouse(172, 20, 2));
    fireEvent.pointerMove(point(3), mouse(190, 20, 2));
    fireEvent.blur(window);
    expect(onDragEnd).toHaveBeenLastCalledWith("c", false);
  });

  it("ends uncommitted on pointercancel", () => {
    const { onDragEnd } = setup();
    fireEvent.pointerDown(point(2), mouse(96, 20));
    fireEvent.pointerMove(point(2), mouse(120, 20));
    fireEvent.pointerCancel(point(2), mouse(120, 20));
    expect(onDragEnd).toHaveBeenCalledWith("b", false);
  });

  it("does not start a drag when the host refuses it", () => {
    const { onMove, onDragStart } = setup();
    onDragStart.mockReturnValue(false);
    fireEvent.pointerDown(point(2), mouse(96, 20));
    fireEvent.pointerMove(point(2), mouse(120, 20));
    expect(onMove).not.toHaveBeenCalled();
  });

  it("does not drag for a guest, who still selects", () => {
    const { onMove, onDragStart, onSelect } = setup({ readOnly: true });
    fireEvent.pointerDown(point(2), mouse(96, 20));
    fireEvent.pointerMove(point(2), mouse(120, 20));
    fireEvent.pointerUp(point(2), mouse(120, 20));
    fireEvent.click(point(2), { detail: 1 });
    expect(onDragStart).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("does not select by the click a drag leaves behind", () => {
    const { onSelect } = setup({ selected: "b" });
    fireEvent.pointerDown(point(2), mouse(96, 20));
    fireEvent.pointerMove(point(2), mouse(120, 20));
    fireEvent.pointerUp(point(2), mouse(120, 20));
    fireEvent.click(point(2), { detail: 1 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("ignores Backspace, Delete and the arrows while a drag moves", () => {
    const { onRemove, onMove } = setup({ selected: "b" });
    fireEvent.pointerDown(point(2), mouse(96, 20));
    fireEvent.pointerMove(point(2), mouse(120, 20));
    onMove.mockClear();
    const seen: string[] = [];
    const listen = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", listen);
    for (const key of ["Backspace", "Delete", "ArrowLeft", "ArrowUp"]) {
      fireEvent.keyDown(point(2), { key });
    }
    window.removeEventListener("keydown", listen);
    expect(onRemove).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});

describe("Envelope keys", () => {
  it("nudges the time 10 ms, Shift 100 ms, by id", () => {
    const { onMove } = setup();
    fireEvent.keyDown(point(2), { key: "ArrowRight" });
    fireEvent.keyDown(point(2), { key: "ArrowLeft", shiftKey: true });
    expect(onMove.mock.calls).toEqual([
      ["b", { timeSeconds: 4.01 }],
      ["b", { timeSeconds: 3.9 }],
    ]);
  });

  it("nudges the level 0.5 dB, Shift 5, Alt 0.05", () => {
    const { onMove } = setup();
    fireEvent.keyDown(point(2), { key: "ArrowUp" });
    fireEvent.keyDown(point(2), { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(point(2), { key: "ArrowUp", altKey: true });
    expect(onMove.mock.calls).toEqual([
      ["b", { db: -5.5 }],
      ["b", { db: -11 }],
      ["b", { db: -5.95 }],
    ]);
  });

  it("holds a nudge to the neighbours and to the scale", () => {
    const { onMove } = setup({
      points: [
        { id: "a", time: 1, db: 3.5 },
        { id: "b", time: 1.005, db: -60 },
      ],
    });
    fireEvent.keyDown(point(1), { key: "ArrowRight" });
    fireEvent.keyDown(point(2), { key: "ArrowLeft" });
    fireEvent.keyDown(point(2), { key: "ArrowDown" });
    expect(onMove.mock.calls).toEqual([
      ["a", { timeSeconds: 1.004 }],
      ["b", { timeSeconds: 1.001 }],
    ]);
    fireEvent.keyDown(point(1), { key: "ArrowUp" });
    expect(onMove).toHaveBeenLastCalledWith("a", { db: 3.52 });
  });

  it("closes the nudge on the key's release and announces the point", () => {
    const { onNudgeEnd, again } = setup();
    fireEvent.keyDown(point(2), { key: "ArrowRight" });
    again({
      points: [
        POINTS[0],
        { ...POINTS[1], time: 4.01 },
        ...POINTS.slice(2),
      ] as EnvelopeProps["points"],
    });
    fireEvent.keyUp(point(2), { key: "ArrowRight" });
    expect(onNudgeEnd).toHaveBeenCalledWith("b");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Envelope point at 0:04.01, −6.0 dB",
    );
  });

  it("holds crowded points where they are, and does not end a step nothing began", () => {
    const { onMove, onNudgeEnd } = setup({
      points: [
        { id: "a", time: 1, db: 0 },
        { id: "b", time: 1, db: 0 },
        { id: "c", time: 1, db: 0 },
      ],
    });
    fireEvent.keyDown(point(2), { key: "ArrowRight" });
    fireEvent.keyUp(point(2), { key: "ArrowRight" });
    fireEvent.keyDown(point(2), { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyUp(point(2), { key: "ArrowLeft" });
    expect(onMove).not.toHaveBeenCalled();
    expect(onNudgeEnd).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("ends and announces nothing for an arrow that moved nothing at a bound", () => {
    const { onMove, onNudgeEnd } = setup({
      points: [{ id: "a", time: 1, db: 3.52 }],
    });
    fireEvent.keyDown(point(1), { key: "ArrowUp" });
    fireEvent.keyUp(point(1), { key: "ArrowUp" });
    expect(onMove).not.toHaveBeenCalled();
    expect(onNudgeEnd).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("makes each 10 ms nudge audible in the slider text", () => {
    const { again } = setup({ points: [{ id: "a", time: 12.04, db: -3 }] });
    expect(point(1)).toHaveAttribute("aria-valuetext", "−3.0 dB at 0:12.04");
    again({ points: [{ id: "a", time: 12.05, db: -3 }] });
    expect(point(1)).toHaveAttribute("aria-valuetext", "−3.0 dB at 0:12.05");
  });

  it("ends the nudge when the window culls the focused point mid-step", () => {
    const { onNudgeEnd, again } = setup();
    fireEvent.keyDown(point(2), { key: "ArrowRight" });
    again({ start: 100 });
    expect(onNudgeEnd).toHaveBeenCalledTimes(1);
    expect(onNudgeEnd).toHaveBeenCalledWith("b");
  });

  it("keeps the live region mounted so removing the last point with the envelope hidden is spoken", () => {
    const { again } = setup({
      points: [{ id: "a", time: 1, db: 0 }],
      selected: "a",
    });
    const region = screen.getByRole("status");
    point(1).focus();
    fireEvent.keyDown(point(1), { key: "Delete" });
    again({ points: [] });
    expect(group).toThrow();
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("Removed envelope point at 0:01.00");
  });

  it("removes a selected point with Backspace or Delete, and moves focus to its neighbour", () => {
    const { onRemove } = setup({ selected: "b" });
    point(2).focus();
    fireEvent.keyDown(point(2), { key: "Backspace" });
    expect(onRemove).toHaveBeenCalledWith("b");
    expect(point(3)).toHaveFocus();
    fireEvent.keyDown(point(3), { key: "Delete" });
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("removes nothing for a point that is not selected, or for a guest, but still keeps the key from the keymap", () => {
    const { onRemove, again } = setup({ selected: "a" });
    const seen: string[] = [];
    const listen = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", listen);
    fireEvent.keyDown(point(2), { key: "Backspace" });
    again({ selected: "b", readOnly: true });
    fireEvent.keyDown(point(2), { key: "Delete" });
    window.removeEventListener("keydown", listen);
    expect(onRemove).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("never lets the keymap hear the keys it handles, and lets the rest through", () => {
    setup({ selected: "b" });
    const seen: string[] = [];
    const listen = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", listen);
    for (const init of [
      { key: "Backspace" },
      { key: "Delete" },
      { key: "ArrowLeft" },
      { key: "ArrowRight", shiftKey: true },
      { key: "ArrowUp", shiftKey: true },
      { key: "ArrowDown", altKey: true },
      { key: "ArrowLeft", altKey: true },
      { key: "Enter" },
      { key: " " },
    ]) {
      fireEvent.keyDown(point(2), init);
    }
    expect(seen).toEqual([]);
    fireEvent.keyDown(point(2), { key: "Escape" });
    fireEvent.keyDown(point(2), { key: "ArrowLeft", ctrlKey: true });
    fireEvent.keyDown(point(2), { key: "ArrowLeft", metaKey: true });
    fireEvent.keyDown(point(2), { key: "Backspace", altKey: true });
    fireEvent.keyDown(point(2), { key: "k" });
    window.removeEventListener("keydown", listen);
    expect(seen).toEqual([
      "Escape",
      "ArrowLeft",
      "ArrowLeft",
      "Backspace",
      "k",
    ]);
  });

  it("lets a guest's plain arrows through to the keymap, and moves nothing", () => {
    const { onMove } = setup({ readOnly: true });
    const seen: string[] = [];
    const listen = (event: KeyboardEvent) => seen.push(event.key);
    document.addEventListener("keydown", listen);
    fireEvent.keyDown(point(2), { key: "ArrowRight" });
    fireEvent.keyDown(point(2), { key: "ArrowUp", shiftKey: true });
    document.removeEventListener("keydown", listen);
    expect(seen).toEqual(["ArrowRight", "ArrowUp"]);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("keeps the browser's scroll off a guest's Up and Down without stopping them", () => {
    setup({ readOnly: true });
    let prevented: boolean[] = [];
    const listen = (event: KeyboardEvent) =>
      prevented.push(event.defaultPrevented);
    document.addEventListener("keydown", listen);
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft"]) {
      fireEvent.keyDown(point(2), { key });
    }
    document.removeEventListener("keydown", listen);
    expect(prevented).toEqual([true, true, false]);
    prevented = [];
  });

  it("still keeps a guest's Alt walk, Backspace, Delete, Enter and Space from the keymap", () => {
    setup({ readOnly: true, selected: "b" });
    const seen: string[] = [];
    const listen = (event: KeyboardEvent) => seen.push(event.key);
    document.addEventListener("keydown", listen);
    fireEvent.keyDown(point(2), { key: "ArrowRight", altKey: true });
    for (const key of ["Backspace", "Delete", "Enter", " "]) {
      fireEvent.keyDown(point(2), { key });
    }
    document.removeEventListener("keydown", listen);
    expect(seen).toEqual([]);
    expect(point(3)).toHaveFocus();
  });

  it("nudges 0.05 dB from an off-grid level without rounding to the 0.1 grid", () => {
    const { onMove } = setup({ points: [{ id: "a", time: 1, db: -1.938 }] });
    fireEvent.keyDown(point(1), { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(point(1), { key: "ArrowDown", altKey: true });
    expect(onMove.mock.calls).toEqual([
      ["a", { db: -1.89 }],
      ["a", { db: -1.99 }],
    ]);
  });

  it("starts a level nudge from the floor for a silent point", () => {
    const { onMove } = setup({ points: [{ id: "a", time: 1, db: -60 }] });
    fireEvent.keyDown(point(1), { key: "ArrowUp" });
    expect(onMove).toHaveBeenLastCalledWith("a", { db: -59.5 });
  });

  it("holds no nudge state: ten presses without the host feeding points back repeat the first step", () => {
    const { onMove } = setup({ points: [{ id: "a", time: 1, db: -6 }] });
    for (let press = 1; press <= 10; press += 1) {
      fireEvent.keyDown(point(1), { key: "ArrowRight", shiftKey: true });
    }
    expect(onMove.mock.calls.map(([, change]) => change.timeSeconds)).toEqual(
      Array(10).fill(1.1),
    );
  });

  it("adds up when the host folds each nudge into the points: ten Right is 100 ms, ten Up is 5 dB, one end", () => {
    const { onMove, onNudgeEnd, again } = setup({
      points: [{ id: "a", time: 1, db: -6 }],
    });
    let now = { id: "a", time: 1, db: -6 };
    const press = (key: string) => {
      fireEvent.keyDown(point(1), { key });
      const change = onMove.mock.calls[onMove.mock.calls.length - 1]?.[1] ?? {};
      now = {
        ...now,
        time: change.timeSeconds ?? now.time,
        db: change.db ?? now.db,
      };
      again({ points: [now] });
    };
    for (let n = 0; n < 10; n += 1) press("ArrowRight");
    expect(now.time).toBe(1.1);
    for (let n = 0; n < 10; n += 1) press("ArrowUp");
    expect(now.db).toBe(-1);
    expect(onNudgeEnd).not.toHaveBeenCalled();
    fireEvent.keyUp(point(1), { key: "ArrowUp" });
    expect(onNudgeEnd).toHaveBeenCalledTimes(1);
  });
});

describe("Envelope hitProps", () => {
  const hit = {
    point: (id: string, time: number, db: number, selected: boolean) => ({
      "data-hit-kind": "envelope-point",
      "data-hit-id": id,
      "data-hit-detail": `${time}:${db}`,
      "data-hit-selected": String(selected),
    }),
    line: { "data-hit-surface": "envelope", "data-hit-own-tap": "true" },
  } as const;

  it("puts the host's attributes on each point, following the selected state, and on the band", () => {
    const { container } = setup({ hitProps: hit, selected: "b" });
    expect(point(2)).toHaveAttribute("data-hit-kind", "envelope-point");
    expect(point(2)).toHaveAttribute("data-hit-id", "b");
    expect(point(2)).toHaveAttribute("data-hit-detail", "4:-6");
    expect(point(2)).toHaveAttribute("data-hit-selected", "true");
    expect(point(3)).toHaveAttribute("data-hit-selected", "false");
    expect(band(container)).toHaveAttribute("data-hit-surface", "envelope");
    expect(band(container)).toHaveAttribute("data-hit-own-tap", "true");
    expect(container.querySelector(".sys-env-line")).not.toHaveAttribute(
      "data-hit-surface",
    );
  });

  it("spreads only data-hit-* strings: a handler, role, style or class never reaches the DOM", () => {
    const dirty = {
      "data-hit-ok": "yes",
      "data-hit-number": 5,
      "data-other": "no",
      role: "button",
      class: "x",
      className: "x",
      style: "color: red",
      onClick: () => undefined,
    } as unknown as Record<`data-hit-${string}`, string>;
    const { container } = setup({
      hitProps: { point: () => dirty, line: dirty },
    });
    for (const el of [point(1), band(container)]) {
      expect(el).toHaveAttribute("data-hit-ok", "yes");
      expect(el).not.toHaveAttribute("data-hit-number");
      expect(el).not.toHaveAttribute("data-other");
      expect(el).not.toHaveAttribute("style", "color: red");
      expect(el).not.toHaveAttribute("class", "x");
    }
    expect(point(1)).toHaveAttribute("role", "slider");
    expect(band(container)).not.toHaveAttribute("role");
    expect(band(container).getAttribute("class")).toBe("sys-env-band");
  });

  it("renders the same DOM without hitProps, with it undefined, empty, or returning nothing", () => {
    const fixtures: Partial<EnvelopeProps>[] = [
      { points: [], visible: true },
      { selected: "b" },
      { readOnly: true, selected: "c" },
      { touch: true, height: 104 },
      { points: [{ id: "a", time: 2, db: 0 }], start: 10 },
    ];
    for (const fixture of fixtures) {
      const html = (extra: Partial<EnvelopeProps>) => {
        const { container, unmount } = setup({ ...fixture, ...extra });
        const out = container.innerHTML;
        unmount();
        return out;
      };
      const plain = html({});
      expect(html({ hitProps: undefined })).toBe(plain);
      expect(html({ hitProps: {} })).toBe(plain);
      expect(html({ hitProps: { point: () => undefined, line: {} } })).toBe(
        plain,
      );
    }
  });
});
