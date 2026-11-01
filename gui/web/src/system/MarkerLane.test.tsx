import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import {
  type LaneMarker,
  MarkerLane,
  type MarkerLaneProps,
} from "./MarkerLane";

const MARKERS: readonly LaneMarker[] = [
  {
    kind: "clip",
    id: "sc-intro",
    start: 46,
    end: 55,
    title: "Tight intro",
    proposed: true,
  },
  { kind: "chapter", id: "ch-open", start: 1, title: "Cold open" },
  { kind: "comment", id: "cm-maya", start: 9, author: "Maya" },
  { kind: "comment", id: "cm-anneke", start: 14, end: 19.5, author: "Anneke" },
  { kind: "chapter", id: "ch-interview", start: 24, title: "Interview" },
  { kind: "clip", id: "sc-joke", start: 30, end: 42, title: "Best joke" },
];

const base: MarkerLaneProps = {
  markers: MARKERS,
  authoritativeMarkers: MARKERS,
  start: 0,
  pxPerSecond: 6,
  width: 360,
  duration: 3130,
  onSelect: () => undefined,
};

function setup(over: Partial<MarkerLaneProps> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onDragStart: vi.fn(),
    onDrag: vi.fn(),
    onDragEnd: vi.fn(),
    onNudge: vi.fn(),
    onNudgeEnd: vi.fn(),
    onAdd: vi.fn(),
    onAddCommit: vi.fn(),
    onAddCancel: vi.fn(),
  };
  const props = {
    ...base,
    ...handlers,
    ...over,
    authoritativeMarkers:
      over.authoritativeMarkers ?? over.markers ?? base.authoritativeMarkers,
  };
  const view = render(<MarkerLane {...props} />);
  const again = (next: Partial<MarkerLaneProps>) =>
    view.rerender(
      <MarkerLane
        {...props}
        {...next}
        authoritativeMarkers={
          next.authoritativeMarkers ??
          next.markers ??
          props.authoritativeMarkers
        }
      />,
    );
  return { ...handlers, ...view, again };
}

const chapter = () =>
  screen.getByRole("button", { name: /^Chapter Interview/ });
const track = () => {
  const el = screen.getByRole("group", { name: "Markers" }).firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error("No track");
  return el;
};
const joke = () => screen.getByRole("button", { name: /^Clip idea Best joke/ });
const edge = (grip: "Start" | "End") =>
  screen.getByRole("slider", { name: `${grip} of Best joke` });
const finger = (pointerId: number, clientX: number) => ({
  pointerId,
  pointerType: "touch",
  clientX,
});
const press = (target: HTMLElement, clientX: number, pointerId = 1) =>
  fireEvent.pointerDown(target, { pointerId, clientX, clientY: 12 });
const moveTo = (
  target: HTMLElement,
  clientX: number,
  pointerId = 1,
  extra = {},
) =>
  fireEvent.pointerMove(target, { pointerId, clientX, clientY: 12, ...extra });

describe("MarkerLane drawing", () => {
  it("names every marker with its kind, title and time, in time order for Tab", () => {
    setup();
    expect(screen.getByRole("group", { name: "Markers" })).toBeVisible();
    expect(
      screen.getAllByRole("button").map((b) => b.getAttribute("aria-label")),
    ).toEqual([
      "Chapter Cold open, 0:01.0",
      "Comment by Maya, 0:09.0",
      "Comment by Anneke, 0:14.0 to 0:19.5",
      "Chapter Interview, 0:24.0",
      "Clip idea Best joke, approved, 0:30.0 to 0:42.0",
      "Clip idea Tight intro, proposed, 0:46.0 to 0:55.0",
    ]);
  });

  it("puts each marker at its time as a fraction of the lane", () => {
    const { container } = setup();
    const at = [...container.querySelectorAll<HTMLElement>(".sys-marker")].map(
      (el) => [
        el.getAttribute("data-kind"),
        el.style.getPropertyValue("--sys-marker-at"),
        el.style.getPropertyValue("--sys-marker-to"),
      ],
    );
    expect(at).toEqual([
      ["chapter", String(6 / 360), String(46 / 360)],
      ["comment", String(46 / 360), ""],
      ["comment", String(84 / 360), String(117 / 360)],
      ["chapter", String(144 / 360), String(180 / 360)],
      ["clip", String(180 / 360), String(252 / 360)],
      ["clip", String(276 / 360), String(330 / 360)],
    ]);
  });

  it("marks the selected markers pressed", () => {
    setup({ selected: ["ch-interview", "cm-maya"] });
    expect(
      screen
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-pressed") === "true")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Comment by Maya, 0:09.0", "Chapter Interview, 0:24.0"]);
  });

  it("scales a touch hit area to half the gap to the neighbour, at most 14 px", () => {
    const { container } = setup();
    const reach = [
      ...container.querySelectorAll<HTMLElement>(".sys-marker"),
    ].map((el) => el.style.getPropertyValue("--sys-marker-reach-inline"));
    expect(reach).toEqual([
      "-3px 0px",
      "0px -11px",
      "-11px -13.5px",
      "-13.5px 0px",
      "0px -12px",
      "-12px -14px",
    ]);
  });

  it("draws nothing for markers more than 64 px outside the window", () => {
    const names = (over: Partial<MarkerLaneProps>) => {
      const { container, unmount } = setup(over);
      const labels = [...container.querySelectorAll(".sys-marker-hit")].map(
        (b) => b.getAttribute("aria-label"),
      );
      unmount();
      return labels;
    };
    expect(names({ start: 24, width: 240 })).toEqual([
      "Comment by Anneke, 0:14.0 to 0:19.5",
      "Chapter Interview, 0:24.0",
      "Clip idea Best joke, approved, 0:30.0 to 0:42.0",
      "Clip idea Tight intro, proposed, 0:46.0 to 0:55.0",
    ]);
    expect(names({ start: 24, width: 60 })).toEqual([
      "Comment by Anneke, 0:14.0 to 0:19.5",
      "Chapter Interview, 0:24.0",
      "Clip idea Best joke, approved, 0:30.0 to 0:42.0",
    ]);
  });

  it("has no axe violations with a selected bracket", async () => {
    const { container } = setup({ selected: ["sc-joke"] });
    await expectNoA11yViolations(container);
  });
});

describe("MarkerLane selecting", () => {
  it("reports the id and whether Shift, Ctrl or Cmd was held", async () => {
    const user = userEvent.setup();
    const { onSelect } = setup();
    await user.click(chapter());
    await user.keyboard("{Shift>}");
    await user.click(joke());
    await user.keyboard("{/Shift}{Control>}");
    await user.click(chapter());
    await user.keyboard("{/Control}");
    fireEvent.click(chapter(), { metaKey: true });
    expect(onSelect.mock.calls).toEqual([
      ["ch-interview", false],
      ["sc-joke", true],
      ["ch-interview", true],
      ["ch-interview", true],
    ]);
  });

  it("selects with Enter and Space from the keyboard", async () => {
    const user = userEvent.setup();
    const { onSelect } = setup();
    await user.tab();
    await user.keyboard("{Enter}");
    await user.tab();
    await user.keyboard(" ");
    expect(onSelect.mock.calls).toEqual([
      ["ch-open", false],
      ["cm-maya", false],
    ]);
  });

  it("is one tab stop per marker and none for the edge handles", async () => {
    const user = userEvent.setup();
    setup({ selected: ["sc-joke"] });
    for (let n = 0; n < 5; n++) await user.tab();
    expect(joke()).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole("button", { name: /^Clip idea Tight intro/ }),
    ).toHaveFocus();
  });
});

describe("MarkerLane moving", () => {
  it("reports a chapter drag from its first 3 px with the pointer, and ends it on release without a select", () => {
    const { onDragStart, onDrag, onDragEnd, onSelect } = setup();
    press(chapter(), 150);
    moveTo(chapter(), 152);
    expect(onDragStart).not.toHaveBeenCalled();
    moveTo(chapter(), 162, 1, { altKey: true });
    moveTo(chapter(), 186, 1, { shiftKey: true });
    fireEvent.pointerUp(chapter(), { pointerId: 1, clientX: 186 });
    fireEvent.click(chapter(), { clientX: 186, detail: 1 });
    expect(onDragStart.mock.calls).toEqual([
      [
        "ch-interview",
        "move",
        { clientX: 162, clientY: 12, shift: false, alt: true },
      ],
    ]);
    expect(onDrag.mock.calls).toEqual([
      [
        "ch-interview",
        "move",
        {
          clientX: 162,
          clientY: 12,
          dx: 12,
          dy: 0,
          shift: false,
          alt: true,
          delta: 2,
          seconds: 27,
        },
      ],
      [
        "ch-interview",
        "move",
        {
          clientX: 186,
          clientY: 12,
          dx: 36,
          dy: 0,
          shift: true,
          alt: false,
          delta: 6,
          seconds: 31,
        },
      ],
    ]);
    expect(onDragEnd.mock.calls).toEqual([["ch-interview", "move", true]]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("treats a press that never moves as a click that selects", () => {
    const { onDragStart, onSelect } = setup();
    press(chapter(), 150);
    fireEvent.pointerUp(chapter(), { pointerId: 1, clientX: 150 });
    fireEvent.click(chapter());
    expect(onDragStart).not.toHaveBeenCalled();
    expect(onSelect.mock.calls).toEqual([["ch-interview", false]]);
  });

  it("drags a bracket whole and by either edge, each as its own grip", () => {
    const { onDragEnd, onDragStart } = setup({ selected: ["sc-joke"] });
    for (const [target, grip] of [
      [joke(), "move"],
      [edge("Start"), "start"],
      [edge("End"), "end"],
    ] as const) {
      press(target, 200);
      moveTo(target, 230);
      fireEvent.pointerUp(target, { pointerId: 1, clientX: 230 });
      expect(onDragStart.mock.calls.at(-1)?.[1]).toBe(grip);
    }
    expect(onDragEnd.mock.calls).toEqual([
      ["sc-joke", "move", true],
      ["sc-joke", "start", true],
      ["sc-joke", "end", true],
    ]);
  });

  it("shows the readout from the marker's current time, so a snapping host shows the snapped time", () => {
    const { again, container } = setup();
    press(chapter(), 150);
    moveTo(chapter(), 162);
    expect(screen.getByText("+0.00 s")).toBeVisible();
    again({
      authoritativeMarkers: MARKERS,
      markers: MARKERS.map((m) =>
        m.id === "ch-interview" ? { ...m, start: 26.25 } : m,
      ),
    });
    expect(container.querySelector(".sys-readout-delta")).toHaveTextContent(
      "+2.25 s",
    );
    expect(container.querySelector(".sys-readout-value")).toHaveTextContent(
      "0:26.25",
    );
    expect(container.querySelector(".sys-readout")).toHaveStyle({
      "--sys-readout-x": "162px",
    });
    again({
      authoritativeMarkers: MARKERS,
      markers: MARKERS.map((m) =>
        m.id === "ch-interview" ? { ...m, start: 22 } : m,
      ),
    });
    expect(container.querySelector(".sys-readout-delta")).toHaveTextContent(
      "−2.00 s",
    );
    fireEvent.pointerUp(chapter(), { pointerId: 1, clientX: 162 });
    expect(container.querySelector(".sys-readout")).toBeNull();
  });

  it("never drags a comment, and drags nothing for a guest", () => {
    const comment = () =>
      screen.getByRole("button", { name: /^Comment by Maya/ });
    const { onDragStart, again } = setup({ selected: ["cm-maya"] });
    press(comment(), 54);
    moveTo(comment(), 80);
    again({ readOnly: true, selected: ["ch-interview"] });
    press(chapter(), 150);
    moveTo(chapter(), 190);
    expect(onDragStart).not.toHaveBeenCalled();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("lets a finger grab only a selected marker, so a swipe over another pans the lane", () => {
    const { onDragStart, again } = setup();
    fireEvent.pointerDown(chapter(), finger(5, 150));
    fireEvent.pointerMove(chapter(), finger(5, 190));
    expect(onDragStart).not.toHaveBeenCalled();
    fireEvent.pointerUp(chapter(), finger(5, 190));
    again({ selected: ["ch-interview"] });
    fireEvent.pointerDown(chapter(), finger(6, 150));
    fireEvent.pointerMove(chapter(), finger(6, 160));
    expect(onDragStart).toHaveBeenCalledTimes(1);
  });

  it("takes a finger's drift of up to 9 px on a selected marker for a tap, and 10 px for a drag that starts without a jump", () => {
    const { onDragStart, onDrag, onDragEnd, onSelect } = setup({
      selected: ["ch-interview"],
    });
    fireEvent.pointerDown(chapter(), finger(7, 150));
    fireEvent.pointerMove(chapter(), finger(7, 159));
    fireEvent.pointerUp(chapter(), finger(7, 159));
    fireEvent.click(chapter(), { detail: 1 });
    expect(onDragStart).not.toHaveBeenCalled();
    expect(onSelect.mock.calls).toEqual([["ch-interview", false]]);
    fireEvent.pointerDown(chapter(), finger(8, 150));
    fireEvent.pointerMove(chapter(), finger(8, 160));
    fireEvent.pointerMove(chapter(), finger(8, 166));
    fireEvent.pointerUp(chapter(), finger(8, 166));
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(
      onDrag.mock.calls.map(([, , drag]) => [drag.dx, drag.delta]),
    ).toEqual([
      [0, 0],
      [6, 1],
    ]);
    expect(onDragEnd.mock.calls).toEqual([["ch-interview", "move", true]]);
  });

  it("keeps a mouse at 3 px, and the first move of a mouse drag is counted from the press", () => {
    const { onDrag } = setup({ selected: ["ch-interview"] });
    press(chapter(), 150);
    moveTo(chapter(), 152);
    moveTo(chapter(), 153);
    fireEvent.pointerUp(chapter(), { pointerId: 1, clientX: 153 });
    expect(onDrag.mock.calls.map(([, , drag]) => drag.dx)).toEqual([3]);
  });

  it("selects with Enter at once after a mouse drag or a touch drag, since no click follows either", async () => {
    const user = userEvent.setup();
    const { onSelect } = setup({ selected: ["ch-interview"] });
    press(chapter(), 150);
    moveTo(chapter(), 190);
    fireEvent.pointerUp(chapter(), { pointerId: 1, clientX: 190 });
    screen.getByRole("button", { name: /^Comment by Maya/ }).focus();
    await user.keyboard("{Enter}");
    expect(onSelect.mock.calls).toEqual([["cm-maya", false]]);
    fireEvent.pointerDown(chapter(), finger(9, 150));
    fireEvent.pointerMove(chapter(), finger(9, 190));
    fireEvent.pointerUp(chapter(), finger(9, 190));
    screen.getByRole("button", { name: /^Comment by Maya/ }).focus();
    await user.keyboard(" ");
    expect(onSelect.mock.calls).toEqual([
      ["cm-maya", false],
      ["cm-maya", false],
    ]);
  });

  it("ignores a second pointer while one has hold, and finishes with the first", () => {
    const { onDrag, onDragEnd } = setup();
    press(chapter(), 150);
    moveTo(chapter(), 160);
    press(chapter(), 300, 2);
    moveTo(chapter(), 340, 2);
    fireEvent.pointerUp(chapter(), { pointerId: 2, clientX: 340 });
    moveTo(chapter(), 170);
    fireEvent.pointerUp(chapter(), { pointerId: 1, clientX: 170 });
    expect(onDrag.mock.calls.map(([, , drag]) => drag.clientX)).toEqual([
      160, 170,
    ]);
    expect(onDragEnd.mock.calls).toEqual([["ch-interview", "move", true]]);
  });

  it("refuses a drag the host refuses and never reports an end for it", () => {
    const { onDrag, onDragEnd } = setup({ onDragStart: () => false });
    press(chapter(), 150);
    moveTo(chapter(), 190);
    moveTo(chapter(), 230);
    fireEvent.pointerUp(chapter(), { pointerId: 1, clientX: 230 });
    expect(onDrag).not.toHaveBeenCalled();
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  const dragging = () => {
    const view = setup();
    press(chapter(), 150);
    moveTo(chapter(), 190);
    return view;
  };

  it("takes Escape from the document wherever focus is, and nothing from the release after", () => {
    const { onDrag, onDragEnd, onSelect } = dragging();
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
    moveTo(chapter(), 230);
    fireEvent.pointerUp(chapter(), { pointerId: 1, clientX: 230 });
    fireEvent.click(chapter(), { detail: 1 });
    expect(onDragEnd.mock.calls).toEqual([["ch-interview", "move", false]]);
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("leaves Escape alone when nothing has moved", () => {
    setup();
    press(chapter(), 150);
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);
  });

  it.each([
    ["chapter", "ch-interview", "move"],
    ["clip", "sc-joke", "move"],
    ["start edge", "sc-joke", "start"],
    ["end edge", "sc-joke", "end"],
  ] as const)(
    "cancels a held %s pointer when focus leaves",
    (kind, id, grip) => {
      const { container, onDragEnd } = setup({ selected: [id] });
      const target =
        kind === "chapter"
          ? chapter()
          : kind === "clip"
            ? joke()
            : edge(grip === "start" ? "Start" : "End");
      target.focus();
      press(target, 180);
      moveTo(track(), 200);
      expect(container.querySelector(".sys-readout")).not.toBeNull();
      fireEvent.blur(target);
      expect(container.querySelector(".sys-readout")).toBeNull();
      moveTo(track(), 220);
      fireEvent.pointerUp(track(), { pointerId: 1, clientX: 220 });
      expect(onDragEnd.mock.calls).toEqual([[id, grip, false]]);
      expect(container.querySelector(".sys-readout")).toBeNull();
      target.focus();
      press(target, 180, 2);
      moveTo(track(), 200, 2);
      fireEvent.pointerUp(track(), { pointerId: 2, clientX: 200 });
      expect(onDragEnd.mock.calls).toEqual([
        [id, grip, false],
        [id, grip, true],
      ]);
    },
  );

  it("ends as not committed on pointercancel, a lost capture and a window blur, once each", () => {
    const { onDragEnd } = dragging();
    const lane = track();
    fireEvent.pointerCancel(chapter(), { pointerId: 1 });
    fireEvent.lostPointerCapture(lane, { pointerId: 1 });
    press(chapter(), 150);
    moveTo(chapter(), 190);
    fireEvent.lostPointerCapture(lane, { pointerId: 1 });
    press(chapter(), 150);
    moveTo(chapter(), 190);
    fireEvent.blur(window);
    expect(onDragEnd.mock.calls).toEqual([
      ["ch-interview", "move", false],
      ["ch-interview", "move", false],
      ["ch-interview", "move", false],
    ]);
  });

  it("hands the pointer to the lane's track when the drag starts, and ignores the pressed button letting go of it", () => {
    const { onDragEnd } = setup();
    const lane = track();
    const capture = vi.fn();
    lane.setPointerCapture = capture;
    press(chapter(), 150);
    moveTo(chapter(), 190);
    expect(capture.mock.calls).toEqual([[1]]);
    fireEvent.lostPointerCapture(chapter(), { pointerId: 1 });
    expect(onDragEnd).not.toHaveBeenCalled();
    fireEvent.pointerUp(lane, { pointerId: 1, clientX: 190 });
    expect(onDragEnd.mock.calls).toEqual([["ch-interview", "move", true]]);
  });

  it("ends as not committed when the lane unmounts mid-drag", () => {
    const { onDragEnd, unmount } = dragging();
    unmount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onDragEnd.mock.calls).toEqual([["ch-interview", "move", false]]);
  });

  it("ends as not committed when the marker goes away, stops being movable, or the lane turns read-only", () => {
    for (const next of [
      { markers: MARKERS.filter((m) => m.id !== "ch-interview") },
      {
        markers: MARKERS.map((m) =>
          m.id === "ch-interview"
            ? ({ kind: "comment", id: m.id, start: 24, author: "A" } as const)
            : m,
        ),
      },
      { readOnly: true },
    ]) {
      const { again, onDragEnd, unmount } = dragging();
      again(next);
      expect(onDragEnd.mock.calls).toEqual([["ch-interview", "move", false]]);
      unmount();
    }
  });

  it("keeps the dragged marker on its own where it would fold into another", () => {
    const { again, onDragEnd } = dragging();
    again({
      authoritativeMarkers: MARKERS,
      markers: MARKERS.map((m) =>
        m.id === "ch-interview" ? { ...m, start: 9.2 } : m,
      ),
    });
    expect(chapter()).toBeVisible();
    expect(onDragEnd).not.toHaveBeenCalled();
  });
});

describe("MarkerLane keys", () => {
  it("nudges a selected chapter 0.1 s, Shift 1 s, and closes the step on release", async () => {
    const user = userEvent.setup();
    const { onNudge, onNudgeEnd } = setup({ selected: ["ch-interview"] });
    chapter().focus();
    await user.keyboard("{ArrowRight}{ArrowLeft}{Shift>}{ArrowRight}{/Shift}");
    expect(onNudge.mock.calls).toEqual([
      ["ch-interview", "move", 0.1, { repeat: false }],
      ["ch-interview", "move", -0.1, { repeat: false }],
      ["ch-interview", "move", 1, { repeat: false }],
    ]);
    expect(onNudgeEnd.mock.calls).toEqual([
      ["ch-interview", "move", true],
      ["ch-interview", "move", true],
      ["ch-interview", "move", true],
    ]);
  });

  it("reports a held key as repeat and closes the step when focus leaves", () => {
    const { onNudge, onNudgeEnd } = setup({ selected: ["ch-interview"] });
    fireEvent.keyDown(chapter(), { key: "ArrowRight" });
    fireEvent.keyDown(chapter(), { key: "ArrowRight", repeat: true });
    expect(onNudge.mock.calls.map(([, , , n]) => n.repeat)).toEqual([
      false,
      true,
    ]);
    fireEvent.blur(chapter());
    fireEvent.keyUp(chapter(), { key: "ArrowRight" });
    expect(onNudgeEnd.mock.calls).toEqual([["ch-interview", "move", true]]);
  });

  it("cancels a nudge when the lane unmounts", () => {
    const { onNudgeEnd, unmount } = setup({ selected: ["ch-interview"] });
    fireEvent.keyDown(chapter(), { key: "ArrowRight" });
    unmount();
    expect(onNudgeEnd.mock.calls).toEqual([["ch-interview", "move", false]]);
  });

  it("stops only the keys it handles and lets the rest reach the keymap", () => {
    setup({ selected: ["ch-interview"] });
    const seen: string[] = [];
    const listen = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", listen);
    fireEvent.keyDown(chapter(), { key: "ArrowRight" });
    fireEvent.keyDown(chapter(), { key: "Delete" });
    fireEvent.keyDown(chapter(), { key: "ArrowUp" });
    fireEvent.keyDown(chapter(), { key: "ArrowLeft", ctrlKey: true });
    fireEvent.keyDown(chapter(), { key: "ArrowLeft", metaKey: true });
    fireEvent.keyDown(chapter(), { key: "ArrowLeft", altKey: true });
    window.removeEventListener("keydown", listen);
    expect(seen).toEqual([
      "Delete",
      "ArrowUp",
      "ArrowLeft",
      "ArrowLeft",
      "ArrowLeft",
    ]);
  });

  it("leaves the arrows to the keymap on a marker that is not selected, a comment, and a guest's", () => {
    const comment = () =>
      screen.getByRole("button", { name: /^Comment by Maya/ });
    const { onNudge, again } = setup();
    const seen: string[] = [];
    const listen = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", listen);
    fireEvent.keyDown(chapter(), { key: "ArrowRight" });
    again({ selected: ["cm-maya"] });
    fireEvent.keyDown(comment(), { key: "ArrowRight" });
    again({ selected: ["ch-interview"], readOnly: true });
    fireEvent.keyDown(chapter(), { key: "ArrowRight" });
    window.removeEventListener("keydown", listen);
    expect(seen).toEqual(["ArrowRight", "ArrowRight", "ArrowRight"]);
    expect(onNudge).not.toHaveBeenCalled();
  });

  it("walks a selected bracket's focus to its edges with Alt, and nudges an edge", async () => {
    const user = userEvent.setup();
    const { onNudge } = setup({ selected: ["sc-joke"] });
    joke().focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(edge("Start")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(edge("End")).toHaveFocus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(edge("End")).toHaveFocus();
    await user.keyboard("{Alt>}{ArrowLeft}{ArrowLeft}{/Alt}");
    expect(joke()).toHaveFocus();
    expect(onNudge.mock.calls).toEqual([
      ["sc-joke", "start", -0.1, { repeat: false }],
      ["sc-joke", "end", 1, { repeat: false }],
    ]);
  });

  it("gives an edge slider its edge as the value, bounded by the other edge", () => {
    setup({ selected: ["sc-joke"] });
    expect(edge("Start")).toHaveAttribute("aria-valuenow", "30");
    expect(edge("Start")).toHaveAttribute("aria-valuemin", "0");
    expect(edge("Start")).toHaveAttribute("aria-valuemax", "41.9");
    expect(edge("Start")).toHaveAttribute("aria-valuetext", "00:30.000");
    expect(edge("End")).toHaveAttribute("aria-valuemin", "30.1");
    expect(edge("End")).toHaveAttribute("aria-valuemax", "3130");
    expect(edge("End")).toHaveAttribute("tabindex", "-1");
  });
});

describe("MarkerLane adding a chapter", () => {
  const track = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(".sys-markers-track") as HTMLElement;

  it("asks for a chapter at the time under a double-click on an empty part", () => {
    const { container, onAdd } = setup();
    fireEvent.doubleClick(track(container), { clientX: 120 });
    expect(onAdd.mock.calls).toEqual([[20]]);
  });

  it("does not ask when the double-click lands on a marker, for a guest, or beyond the episode", () => {
    const { container, onAdd, again } = setup({ duration: 100 });
    fireEvent.doubleClick(chapter());
    fireEvent.doubleClick(track(container), { clientX: 99999 });
    again({ readOnly: true });
    fireEvent.doubleClick(track(container), { clientX: 120 });
    expect(onAdd.mock.calls).toEqual([[100]]);
  });

  it("opens a focused name field and commits the trimmed title at the time with Enter", async () => {
    const user = userEvent.setup();
    const { onAddCommit, onAddCancel } = setup({ adding: { at: 12 } });
    const field = screen.getByRole("textbox", { name: "Chapter name" });
    expect(field).toHaveFocus();
    await user.keyboard("  Q and A {Enter}");
    expect(onAddCommit.mock.calls).toEqual([[12, "Q and A"]]);
    fireEvent.blur(field);
    expect(onAddCommit).toHaveBeenCalledTimes(1);
    expect(onAddCancel).not.toHaveBeenCalled();
  });

  it("refuses an empty name and keeps the field open", async () => {
    const user = userEvent.setup();
    const { onAddCommit, onAddCancel } = setup({ adding: { at: 12 } });
    await user.keyboard("   {Enter}");
    expect(onAddCommit).not.toHaveBeenCalled();
    expect(onAddCancel).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Chapter name" }),
    ).toHaveAttribute("aria-invalid", "true");
    await user.keyboard("x");
    expect(
      screen.getByRole("textbox", { name: "Chapter name" }),
    ).not.toHaveAttribute("aria-invalid");
  });

  it("cancels on Escape without letting the keymap see it, and on a blur with nothing typed", async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    const listen = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", listen);
    const { onAddCancel, onAddCommit } = setup({ adding: { at: 12 } });
    await user.keyboard("abc{Escape}");
    window.removeEventListener("keydown", listen);
    expect(onAddCancel).toHaveBeenCalledTimes(1);
    expect(onAddCommit).not.toHaveBeenCalled();
    expect(seen).not.toContain("Escape");
    const blurred = setup({ adding: { at: 5 } });
    fireEvent.blur(
      screen.getAllByRole("textbox", {
        name: "Chapter name",
      })[1] as HTMLElement,
    );
    expect(blurred.onAddCancel).toHaveBeenCalledTimes(1);
  });

  it("commits what was typed when focus leaves", async () => {
    const user = userEvent.setup();
    const { onAddCommit } = setup({ adding: { at: 12 } });
    await user.keyboard("Intro");
    fireEvent.blur(screen.getByRole("textbox", { name: "Chapter name" }));
    expect(onAddCommit.mock.calls).toEqual([[12, "Intro"]]);
  });

  it("does not send an IME's own Enter", () => {
    const { onAddCommit } = setup({ adding: { at: 12 } });
    const field = screen.getByRole("textbox", { name: "Chapter name" });
    fireEvent.change(field, { target: { value: "にほん" } });
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    expect(onAddCommit).not.toHaveBeenCalled();
  });

  it("draws no field without the commit and cancel callbacks, or when not adding", () => {
    setup({ adding: null });
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("MarkerLane stacks", () => {
  const crowded: readonly LaneMarker[] = [
    { kind: "comment", id: "p1", start: 10, author: "Maya" },
    { kind: "comment", id: "p2", start: 10.5, author: "Anneke" },
    { kind: "chapter", id: "ch", start: 12, title: "Later" },
    { kind: "clip", id: "far", start: 20, end: 25, title: "Far" },
  ];

  it("folds overlapping markers into the earliest and a +N chip, and lists the rest", async () => {
    const user = userEvent.setup();
    const { onSelect } = setup({ markers: crowded });
    expect(
      screen.getAllByRole("button").map((b) => b.getAttribute("aria-label")),
    ).toEqual([
      "Comment by Maya, 0:10.0",
      "2 more markers",
      "Clip idea Far, approved, 0:20.0 to 0:25.0",
    ]);
    expect(
      screen.getByRole("button", { name: "2 more markers" }),
    ).toHaveTextContent("+2");
    await user.click(screen.getByRole("button", { name: "2 more markers" }));
    const rows = within(document.body).getAllByRole("menuitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "Comment by Anneke, 0:10.5",
      "Chapter Later, 0:12.0",
    ]);
    await user.click(rows[1] as HTMLElement);
    expect(onSelect.mock.calls).toEqual([["ch", false]]);
    expect(within(document.body).queryByRole("menuitem")).toBeNull();
  });

  it("says one more marker in the singular and marks the chip when a hidden marker is selected", () => {
    const { again } = setup({ markers: crowded.slice(0, 2) });
    const chip = () => screen.getByRole("button", { name: "1 more marker" });
    expect(chip()).not.toHaveAttribute("aria-pressed");
    expect(chip().closest(".sys-marker")).not.toHaveAttribute("data-selected");
    again({ selected: ["p2"] });
    expect(chip().closest(".sys-marker")).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(chip()).toHaveAttribute("aria-pressed", "true");
  });

  it("marks the marker a chip follows, so its start edge leaves room for the chip", () => {
    setup({ markers: crowded });
    const marks = [...document.querySelectorAll(".sys-marker")].map((el) => [
      el.getAttribute("data-kind"),
      el.getAttribute("data-stacked"),
    ]);
    expect(marks).toEqual([
      ["comment", "true"],
      ["stack", null],
      ["clip", null],
    ]);
  });

  it("keeps a chapter inside a clip's span on its own, and unfolds nothing when the window zooms", () => {
    const nested: readonly LaneMarker[] = [
      { kind: "clip", id: "long", start: 0, end: 50, title: "Long" },
      { kind: "chapter", id: "inside", start: 25, title: "Inside" },
    ];
    const { again } = setup({ markers: nested });
    const names = () =>
      screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names()).toEqual([
      "Clip idea Long, approved, 0:00.0 to 0:50.0",
      "Chapter Inside, 0:25.0",
    ]);
    again({ pxPerSecond: 60, start: 24.5 });
    expect(names()).toEqual([
      "Clip idea Long, approved, 0:00.0 to 0:50.0",
      "Chapter Inside, 0:25.0",
    ]);
  });

  it("unfolds the chip when the window zooms in", () => {
    const { again } = setup({ markers: crowded });
    expect(
      screen.getByRole("button", { name: "2 more markers" }),
    ).toBeVisible();
    again({ pxPerSecond: 60, start: 9 });
    expect(screen.queryByRole("button", { name: /more marker/ })).toBeNull();
    expect(
      screen.getAllByRole("button").map((b) => b.getAttribute("aria-label")),
    ).toEqual([
      "Comment by Maya, 0:10.0",
      "Comment by Anneke, 0:10.5",
      "Chapter Later, 0:12.0",
    ]);
  });
});

describe("MarkerLane passthrough", () => {
  it("puts the anchor on the root and the hit attributes per marker and grip", () => {
    const hit = (id: string, grip: string) => ({
      "data-hit-id": `${id}:${grip}`,
    });
    const { container } = setup({
      selected: ["sc-joke"],
      anchorProps: { "data-presence-anchor": "markers" },
      hitProps: hit,
    });
    expect(container.querySelector(".sys-markers")).toHaveAttribute(
      "data-presence-anchor",
      "markers",
    );
    expect(chapter()).toHaveAttribute("data-hit-id", "ch-interview:move");
    expect(edge("Start")).toHaveAttribute("data-hit-id", "sc-joke:start");
    expect(edge("End")).toHaveAttribute("data-hit-id", "sc-joke:end");
  });

  it("marks the lane for touch and for a guest", () => {
    const { container } = setup({ touch: true, readOnly: true });
    expect(container.querySelector(".sys-markers")).toHaveAttribute(
      "data-touch",
      "true",
    );
    expect(container.querySelector(".sys-markers")).toHaveAttribute(
      "data-readonly",
      "true",
    );
    expect(chapter()).not.toHaveAttribute("data-movable");
  });

  it("marks a movable marker so the cursor and touch-action can follow", () => {
    setup();
    expect(chapter()).toHaveAttribute("data-movable", "true");
    expect(
      screen.getByRole("button", { name: /^Comment by Maya/ }),
    ).not.toHaveAttribute("data-movable");
  });
});

describe("MarkerLane drag limits", () => {
  const moves = (calls: unknown[][]) =>
    calls.map(([, , drag]) => {
      const { delta, seconds } = drag as { delta: number; seconds: number };
      return [Number(delta.toFixed(3)), Number(seconds.toFixed(3))];
    });

  it("keeps a chapter dragged off the episode inside it, with the delta that gets it there", () => {
    const { onDrag } = setup({ duration: 40 });
    press(chapter(), 150);
    moveTo(chapter(), 160);
    moveTo(track(), -3000);
    moveTo(track(), 3000);
    fireEvent.pointerUp(track(), { pointerId: 1, clientX: 3000 });
    expect(moves(onDrag.mock.calls)).toEqual([
      [1.667, 26.667],
      [-24, 0],
      [16, 40],
    ]);
  });

  it("keeps a whole clip inside the episode and a clip edge off the opposite edge", () => {
    const { onDrag } = setup({ duration: 50, selected: ["sc-joke"] });
    press(joke(), 200);
    moveTo(track(), 3000);
    moveTo(track(), -3000);
    fireEvent.pointerUp(track(), { pointerId: 1, clientX: -3000 });
    press(edge("End"), 252, 2);
    moveTo(track(), 0, 2);
    fireEvent.pointerUp(track(), { pointerId: 2, clientX: 0 });
    press(edge("Start"), 180, 3);
    moveTo(track(), 3000, 3);
    fireEvent.pointerUp(track(), { pointerId: 3, clientX: 3000 });
    expect(moves(onDrag.mock.calls)).toEqual([
      [8, 50],
      [-30, 0],
      [-11.9, 0],
      [11.9, 50],
    ]);
  });

  it("does not pin a clip longer than the episode, or any marker while the duration is 0", () => {
    const long = setup({
      duration: 36,
      selected: ["sc-joke"],
      markers: [
        { kind: "clip", id: "sc-joke", start: 10, end: 70, title: "Best joke" },
      ],
    });
    press(joke(), 100);
    moveTo(track(), 130);
    moveTo(track(), 70);
    expect(moves(long.onDrag.mock.calls).map(([delta]) => delta)).toEqual([
      5, -5,
    ]);
    long.unmount();
    const unloaded = setup({ duration: 0 });
    press(chapter(), 150);
    moveTo(chapter(), 168);
    expect(moves(unloaded.onDrag.mock.calls).map(([delta]) => delta)).toEqual([
      3,
    ]);
  });

  it("reads an edge slider inside its limits", () => {
    setup({
      selected: ["sc-joke"],
      markers: [
        { kind: "clip", id: "sc-joke", start: 30, end: 42, title: "Best joke" },
      ],
      duration: 40,
    });
    expect(edge("End")).toHaveAttribute("aria-valuenow", "40");
  });
});

describe("MarkerLane keys during a drag", () => {
  const SWALLOWED = ["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "];

  it("ignores the nudge and select keys while a drag is moving, keeps Escape live, and nudges after", () => {
    const { onNudge, onSelect, onDragEnd } = setup({
      selected: ["ch-interview"],
    });
    press(chapter(), 150);
    for (const key of ["Home", "End"]) {
      expect(fireEvent.keyDown(chapter(), { key })).toBe(true);
    }
    fireEvent.keyDown(chapter(), { key: "ArrowRight" });
    expect(onNudge).toHaveBeenCalledTimes(1);
    moveTo(chapter(), 190);
    for (const key of SWALLOWED) {
      expect(fireEvent.keyDown(chapter(), { key })).toBe(false);
    }
    expect(onNudge).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
    expect(onDragEnd.mock.calls).toEqual([["ch-interview", "move", false]]);
    fireEvent.keyDown(chapter(), { key: "ArrowRight" });
    expect(onNudge).toHaveBeenCalledTimes(2);
  });

  it("swallows the keys on any marker mid-drag, and still walks a bracket's focus with Alt", () => {
    setup({ selected: ["sc-joke"] });
    press(joke(), 200);
    moveTo(joke(), 230);
    const comment = screen.getByRole("button", { name: /^Comment by Maya/ });
    expect(fireEvent.keyDown(comment, { key: "Enter" })).toBe(false);
    fireEvent.keyDown(joke(), { key: "ArrowRight", altKey: true });
    expect(edge("Start")).toHaveFocus();
  });
});

describe("MarkerLane gesture coordinate lifetime", () => {
  it.each([{ start: 1 }, { pxPerSecond: 12 }, { duration: 3200 }])(
    "cancels an accepted press before movement when coordinates change %j",
    (next) => {
      const { again, onDragStart, onDragEnd } = setup({
        selected: ["ch-interview"],
      });
      press(chapter(), 150);
      again(next);
      moveTo(track(), 180);
      fireEvent.pointerUp(track(), { pointerId: 1, clientX: 180 });
      expect(onDragStart).not.toHaveBeenCalled();
      expect(onDragEnd).not.toHaveBeenCalled();
    },
  );

  it.each([
    { start: 1 },
    { pxPerSecond: 12 },
    { duration: 3200 },
    { readOnly: true },
    { markers: MARKERS.filter((marker) => marker.id !== "ch-interview") },
  ])("cancels held keys on invalidation %j", (next) => {
    const { again, onNudge, onNudgeEnd } = setup({
      selected: ["ch-interview"],
    });
    fireEvent.keyDown(chapter(), { key: "ArrowRight" });
    again(next);
    expect(onNudgeEnd).toHaveBeenCalledExactlyOnceWith(
      "ch-interview",
      "move",
      false,
    );
    expect(onNudge).toHaveBeenCalledOnce();
  });

  it("Escape cancels held keys before blur or keyup", () => {
    const { onNudgeEnd } = setup({ selected: ["ch-interview"] });
    fireEvent.keyDown(chapter(), { key: "ArrowRight" });
    fireEvent.keyDown(chapter(), { key: "Escape" });
    fireEvent.blur(chapter());
    fireEvent.keyUp(chapter(), { key: "ArrowRight" });
    expect(onNudgeEnd).toHaveBeenCalledExactlyOnceWith(
      "ch-interview",
      "move",
      false,
    );
  });
});
