import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import type { AutomationPoint, ClipRow } from "../types/project";
import { LaneEnvelope } from "./LaneEnvelope";
import { TimelineGestureProvider } from "./timelineMetrics";
import { useRulerWindow } from "./useRulerWindow";

const setEnvelope = vi.fn();

vi.mock("../api", () => ({
  setEnvelope: (...args: unknown[]) => setEnvelope(...args),
}));

const POINTS: AutomationPoint[] = [
  { id: "a", time: 1, value: 1 },
  { id: "b", time: 4, value: 0.8 },
  { id: "c", time: 10, value: 1.5 },
];

const putPoints = (points: AutomationPoint[]) =>
  act(() =>
    useDawStore.setState((s) => ({
      project: {
        ...s.project!,
        envelopes: [{ track_id: "host", parameter: "volume", points }],
      },
    })),
  );

/** The host answers a save by replacing the points, as the real one does. */
const hostSaves = () =>
  setEnvelope.mockImplementation(
    async (_path: string, _track: string, points: AutomationPoint[]) => {
      putPoints(points);
      return null;
    },
  );

function Harness({
  canvas = 360,
  clips = [],
}: {
  canvas?: number;
  clips?: ClipRow[];
}) {
  const envelopes = useDawStore((s) => s.project?.envelopes ?? []);
  return (
    <LaneEnvelope
      trackId="host"
      trackName="Maya"
      colorIndex={0}
      envelopes={envelopes}
      clips={clips}
      zoomPxPerSec={24}
      width={canvas}
    />
  );
}

const hold = vi.fn();
const release = vi.fn();

function setup(canvas?: number, clips?: ClipRow[]) {
  hold.mockReset().mockReturnValue(release);
  release.mockReset();
  return render(
    <TimelineGestureProvider value={hold}>
      <Harness canvas={canvas} clips={clips} />
    </TimelineGestureProvider>,
  );
}

const point = (place: number) =>
  screen.getByRole("slider", { name: `Envelope point ${place}` });
const mouse = (clientX: number, clientY: number) => ({
  pointerId: 1,
  pointerType: "mouse",
  button: 0,
  clientX,
  clientY,
});
const stored = () =>
  useDawStore.getState().project!.envelopes[0]!.points as AutomationPoint[];
const lastSave = () =>
  setEnvelope.mock.calls[
    setEnvelope.mock.calls.length - 1
  ]![2] as AutomationPoint[];
const toasts = () => vi.spyOn(useDawStore.getState(), "announceStatus");

/** Pointer down on point `place`, `dx` px right and `dy` px down, held. */
function dragPoint(place: number, dx: number, dy: number) {
  const el = point(place);
  const x = Number(el.style.getPropertyValue("--sys-env-x").replace("px", ""));
  fireEvent.pointerDown(el, mouse(x, 20));
  fireEvent.pointerMove(el, mouse(x + dx, 20 + dy));
  return { el, x };
}

beforeEach(() => {
  setEnvelope.mockReset();
  hostSaves();
  useDawStore.getState().hydrate(
    "/tmp/p.json",
    minimalProject({
      tracks: [sampleTrack({ id: "host" })],
      timeline_duration_sec: 60,
      envelopes: [
        {
          track_id: "host",
          parameter: "volume",
          points: structuredClone(POINTS),
        },
      ],
    }),
  );
  useDawStore.getState().setLayerVisible("showLevels", true);
  useDawStore.getState().setSelection(null);
  useDawStore.setState({ timelineViewportWidth: 360, scrollLeft: 0 });
});

describe("LaneEnvelope drawing", () => {
  it("draws the stored gain as dB, with the track's name and the lane hooks", () => {
    setup();
    expect(
      screen.getByRole("group", { name: "Volume envelope, Maya" }),
    ).toBeVisible();
    expect(point(1)).toHaveAttribute("aria-valuenow", "0");
    expect(point(2)).toHaveAttribute("aria-valuenow", "-1.9");
    expect(point(3)).toHaveAttribute("aria-valuenow", "3.5");
    expect(screen.getByTestId("timeline-envelope")).toHaveClass(
      "lane-envelope-window",
    );
  });

  it("draws the unity line with no points", () => {
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        tracks: [sampleTrack({ id: "host" })],
        envelopes: [],
      }),
    );
    setup();
    expect(
      screen.getByRole("group", { name: "Volume envelope, Maya" }),
    ).toBeVisible();
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
  });

  it("leaves out a point whose time or level is not a number", () => {
    putPoints([...POINTS, { id: "x", time: Number.NaN, value: 1 }]);
    setup();
    expect(screen.getAllByRole("slider")).toHaveLength(3);
  });

  it("takes the ruler's window, at a deep zoom as at none", () => {
    act(() =>
      useDawStore.setState({ timelineViewportWidth: 400, scrollLeft: 3100 }),
    );
    const expected = renderHook(() => useRulerWindow(10_000, 400)).result
      .current;
    setup(10_000);
    const win = screen.getByTestId("timeline-envelope");
    expect(win.style.left).toBe(`${expected.left}px`);
    expect(win.style.width).toBe(`${expected.width}px`);
    expect(expected.width).toBeLessThan(10_000);
  });

  it("marks selection and puts the hit attributes on the points and the line", () => {
    act(() =>
      useDawStore
        .getState()
        .setSelection({ kind: "envelopePoint", trackId: "host", pointId: "b" }),
    );
    const { container } = setup();
    expect(point(2)).toHaveAttribute("aria-current", "true");
    expect(point(2)).toHaveAttribute("data-hit-kind", "envelope-point");
    expect(point(2)).toHaveAttribute("data-hit-id", "b");
    expect(point(2)).toHaveAttribute("data-hit-detail", "0.80");
    expect(point(2)).toHaveAttribute("data-hit-selected", "true");
    expect(point(1)).not.toHaveAttribute("data-hit-selected");
    const band = container.querySelector(".sys-env-band")!;
    expect(band).toHaveAttribute("data-hit-surface");
    expect(band).toHaveAttribute("data-hit-own-tap");
  });
});

describe("LaneEnvelope drags", () => {
  it("saves a time-only drag once, without rewriting the level", async () => {
    setup();
    const { el } = dragPoint(2, 48, 1);
    fireEvent.pointerUp(el, mouse(0, 0));
    await act(async () => {});
    expect(setEnvelope).toHaveBeenCalledTimes(1);
    expect(lastSave().find((p) => p.id === "b")).toEqual({
      id: "b",
      time: 6,
      value: 0.8,
    });
    expect(useDawStore.getState().selection).toMatchObject({ pointId: "b" });
  });

  it("saves a level-only drag at the dragged level, time untouched", async () => {
    setup();
    const { el } = dragPoint(2, 1, 12);
    fireEvent.pointerUp(el, mouse(0, 0));
    await act(async () => {});
    expect(setEnvelope).toHaveBeenCalledTimes(1);
    const saved = lastSave().find((p) => p.id === "b")!;
    expect(saved.time).toBe(4);
    expect(saved.value).not.toBe(0.8);
    expect(saved.value).toBeLessThan(0.8);
  });

  it("saves nothing for a drag that comes back to where it started", async () => {
    setup();
    const { el, x } = dragPoint(2, 48, 0);
    fireEvent.pointerMove(el, mouse(x, 20));
    fireEvent.pointerUp(el, mouse(x, 20));
    await act(async () => {});
    expect(setEnvelope).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it("holds the point and the lane geometry until the save settles", async () => {
    let finish: (undo: null) => void = () => {};
    setEnvelope.mockImplementationOnce(
      (_p: string, _t: string, points: AutomationPoint[]) =>
        new Promise((resolve) => {
          finish = () => {
            putPoints(points);
            resolve(null);
          };
        }),
    );
    setup();
    const { el } = dragPoint(2, 48, 0);
    expect(hold).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(el, mouse(0, 0));
    await act(async () => {});
    expect(setEnvelope).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(point(2).getAttribute("aria-valuetext")).toContain("0:06");
    // A second drag is refused while the save runs.
    fireEvent.pointerDown(point(2), mouse(144, 20));
    fireEvent.pointerMove(point(2), mouse(200, 20));
    expect(hold).toHaveBeenCalledTimes(1);
    await act(async () => finish(null));
    expect(release).toHaveBeenCalledTimes(1);
    expect(point(2).getAttribute("aria-valuetext")).toContain("0:06");
    expect(stored().find((p) => p.id === "b")!.time).toBe(6);
  });

  it("puts the point back and says why when the save is refused", async () => {
    setEnvelope.mockRejectedValueOnce(new Error("offline"));
    const announce = toasts();
    setup();
    const { el } = dragPoint(2, 48, 0);
    fireEvent.pointerUp(el, mouse(0, 0));
    await act(async () => {});
    expect(announce).toHaveBeenCalledWith(expect.stringContaining("offline"), {
      tone: "error",
    });
    expect(point(2).getAttribute("aria-valuetext")).toContain("0:04");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("restores on Escape without a save, and keeps the point selected", async () => {
    setup();
    dragPoint(2, 48, 0);
    fireEvent.keyDown(document, { key: "Escape" });
    await act(async () => {});
    expect(setEnvelope).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(useDawStore.getState().selection).toMatchObject({ pointId: "b" });
    expect(stored().find((p) => p.id === "b")!.time).toBe(4);
  });

  it("saves nothing when a remote edit removed the point mid-drag", async () => {
    setup();
    dragPoint(2, 48, 0);
    putPoints(POINTS.filter((p) => p.id !== "b"));
    fireEvent.pointerUp(
      screen.getByRole("group", { name: "Volume envelope, Maya" }),
      mouse(0, 0),
    );
    await act(async () => {});
    expect(setEnvelope).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it("does not drag for a guest, who still selects", async () => {
    useDawStore.setState({
      projectPath: "share:tok",
      shareCapabilities: ["view"],
    });
    setup();
    const { el } = dragPoint(2, 48, 0);
    fireEvent.pointerUp(el, mouse(0, 0));
    fireEvent.click(el, { detail: 1 });
    await act(async () => {});
    expect(setEnvelope).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    expect(useDawStore.getState().selection).toMatchObject({ pointId: "b" });
  });
});

describe("LaneEnvelope keys", () => {
  it("previews a held nudge and saves one step on release", async () => {
    setup();
    point(2).focus();
    for (let i = 0; i < 3; i++)
      fireEvent.keyDown(point(2), { key: "ArrowRight" });
    expect(setEnvelope).not.toHaveBeenCalled();
    expect(point(2).getAttribute("aria-valuetext")).toContain("0:04.03");
    fireEvent.keyUp(point(2), { key: "ArrowRight" });
    await act(async () => {});
    expect(setEnvelope).toHaveBeenCalledTimes(1);
    expect(lastSave().find((p) => p.id === "b")).toEqual({
      id: "b",
      time: 4.03,
      value: 0.8,
    });
  });

  it("opens no undo step for a nudge that lands on the stored level", async () => {
    setup();
    point(3).focus();
    fireEvent.keyDown(point(3), { key: "ArrowUp" });
    fireEvent.keyUp(point(3), { key: "ArrowUp" });
    await act(async () => {});
    expect(setEnvelope).not.toHaveBeenCalled();
    expect(point(3).getAttribute("aria-valuetext")).toContain("3.5");
  });

  it("drops the nudge preview when the save is refused", async () => {
    setEnvelope.mockRejectedValueOnce(new Error("offline"));
    setup();
    point(2).focus();
    fireEvent.keyDown(point(2), { key: "ArrowDown" });
    fireEvent.keyUp(point(2), { key: "ArrowDown" });
    await act(async () => {});
    expect(point(2)).toHaveAttribute("aria-valuenow", "-1.9");
  });

  it("refuses a drag while a nudge is held, and saves only the nudge", async () => {
    setup();
    point(2).focus();
    fireEvent.keyDown(point(2), { key: "ArrowRight" });
    dragPoint(2, 1, 20);
    expect(hold).not.toHaveBeenCalled();
    fireEvent.keyUp(point(2), { key: "ArrowRight" });
    await act(async () => {});
    expect(setEnvelope).toHaveBeenCalledTimes(1);
    expect(lastSave().find((p) => p.id === "b")!.value).toBe(0.8);
  });

  it("drops a nudge in progress on unmount without saving", async () => {
    const view = setup();
    point(2).focus();
    fireEvent.keyDown(point(2), { key: "ArrowRight" });
    view.unmount();
    await act(async () => {});
    expect(setEnvelope).not.toHaveBeenCalled();
  });

  it("removes the selected point with Delete and Backspace", async () => {
    act(() =>
      useDawStore
        .getState()
        .setSelection({ kind: "envelopePoint", trackId: "host", pointId: "b" }),
    );
    setup();
    point(2).focus();
    fireEvent.keyDown(point(2), { key: "Delete" });
    await act(async () => {});
    expect(setEnvelope).toHaveBeenCalledTimes(1);
    expect(lastSave().map((p) => p.id)).toEqual(["a", "c"]);
    point(1).focus();
    act(() =>
      useDawStore
        .getState()
        .setSelection({ kind: "envelopePoint", trackId: "host", pointId: "a" }),
    );
    fireEvent.keyDown(point(1), { key: "Backspace" });
    await act(async () => {});
    expect(lastSave().map((p) => p.id)).toEqual(["c"]);
  });

  it("lets a guest's arrows reach the keymap and changes nothing", async () => {
    useDawStore.setState({
      projectPath: "share:tok",
      shareCapabilities: ["view"],
    });
    const seen: string[] = [];
    render(
      <TimelineGestureProvider value={hold}>
        <div role="presentation" onKeyDown={(event) => seen.push(event.key)}>
          <Harness />
        </div>
      </TimelineGestureProvider>,
    );
    point(2).focus();
    fireEvent.keyDown(point(2), { key: "ArrowRight" });
    fireEvent.keyDown(point(2), { key: "ArrowDown" });
    fireEvent.keyUp(point(2), { key: "ArrowRight" });
    await act(async () => {});
    expect(seen).toEqual(["ArrowRight", "ArrowDown"]);
    expect(setEnvelope).not.toHaveBeenCalled();
  });
});

describe("LaneEnvelope adding", () => {
  const clickLine = (container: HTMLElement, x: number, y: number) => {
    const band = container.querySelector(".sys-env-band")!;
    fireEvent.pointerDown(band, mouse(x, y));
    fireEvent.click(band, { clientX: x, clientY: y, detail: 1 });
  };

  it("adds a point at the click's time and level, selects it, one save", async () => {
    const { container } = setup();
    clickLine(container, 120, 30);
    await act(async () => {});
    expect(setEnvelope).toHaveBeenCalledTimes(1);
    const added = lastSave().find((p) => !POINTS.some((q) => q.id === p.id))!;
    expect(added.time).toBe(5);
    expect(added.value).toBeGreaterThan(0);
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "envelopePoint",
      pointId: added.id,
    });
  });

  it("writes three points for the first click on an empty envelope", async () => {
    putPoints([]);
    const { container } = setup();
    clickLine(container, 120, 30);
    await act(async () => {});
    expect(lastSave()).toHaveLength(3);
  });

  it("refuses a guest", async () => {
    useDawStore.setState({
      projectPath: "share:tok",
      shareCapabilities: ["view"],
    });
    const view = setup();
    clickLine(view.container, 120, 30);
    await act(async () => {});
    expect(setEnvelope).not.toHaveBeenCalled();
  });

  it("refuses to add while a save is in flight", async () => {
    let finish: () => void = () => {};
    setEnvelope.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(null);
        }),
    );
    const announce = toasts();
    const { container } = setup();
    clickLine(container, 120, 30);
    clickLine(container, 200, 30);
    await act(async () => {});
    expect(setEnvelope).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(
      "Wait for the volume envelope to finish saving",
      { tone: "error" },
    );
    await act(async () => finish());
  });
});

describe("LaneEnvelope while a save settles", () => {
  /** A drag of point 2 two seconds right whose save the test finishes by hand. */
  async function savedDrag(updateStore: "before" | "after" | "never") {
    let finish: () => void = () => {};
    setEnvelope.mockImplementationOnce(
      (_p: string, _t: string, points: AutomationPoint[]) =>
        new Promise((resolve) => {
          finish = () => {
            if (updateStore === "before") putPoints(points);
            resolve(null);
          };
        }),
    );
    setup();
    const { el } = dragPoint(2, 48, 0);
    fireEvent.pointerUp(el, mouse(0, 0));
    await act(async () => {});
    const points = lastSave();
    return { finish: () => act(async () => finish()), points };
  }

  it("does not drop a point being saved when Delete is pressed", async () => {
    const announce = toasts();
    const { finish } = await savedDrag("before");
    act(() =>
      useDawStore
        .getState()
        .setSelection({ kind: "envelopePoint", trackId: "host", pointId: "b" }),
    );
    point(2).focus();
    fireEvent.keyDown(point(2), { key: "Delete" });
    await act(async () => {});
    expect(setEnvelope).toHaveBeenCalledTimes(1);
    expect(point(2).getAttribute("aria-valuetext")).toContain("0:06");
    expect(release).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith(
      "Wait for the volume envelope to finish saving",
      { tone: "error" },
    );
    await finish();
    expect(stored().find((p) => p.id === "b")!.time).toBe(6);
  });

  it("keeps the saved point when the store follows after the save resolves", async () => {
    const { finish, points } = await savedDrag("after");
    await finish();
    expect(release).toHaveBeenCalledTimes(1);
    expect(point(2).getAttribute("aria-valuetext")).toContain("0:06");
    putPoints(points);
    await act(async () => {});
    expect(point(2).getAttribute("aria-valuetext")).toContain("0:06");
    expect(stored().find((p) => p.id === "b")!.time).toBe(6);
  });

  it("holds a nudge and Delete until a lagging store follows; the pause then lets a nudge save, documenting the residual stale baseline (b at 4) of a store that never follows", async () => {
    vi.useFakeTimers();
    try {
      const { finish } = await savedDrag("never");
      await finish();
      point(2).focus();
      fireEvent.keyDown(point(2), { key: "ArrowRight" });
      fireEvent.keyUp(point(2), { key: "ArrowRight" });
      fireEvent.keyDown(point(2), { key: "Delete" });
      await act(async () => {});
      // The store still holds b at 4: a save now would send a stale baseline.
      expect(setEnvelope).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTime(1500));
      fireEvent.keyDown(point(2), { key: "ArrowRight" });
      fireEvent.keyUp(point(2), { key: "ArrowRight" });
      await act(async () => {});
      expect(setEnvelope).toHaveBeenCalledTimes(2);
      const baseline = setEnvelope.mock.calls[1]![3] as AutomationPoint[];
      expect(baseline.find((p) => p.id === "b")!.time).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves a nudge once the store has followed, from the saved points", async () => {
    const { finish, points } = await savedDrag("after");
    await finish();
    putPoints(points);
    await act(async () => {});
    point(2).focus();
    fireEvent.keyDown(point(2), { key: "ArrowRight" });
    fireEvent.keyUp(point(2), { key: "ArrowRight" });
    await act(async () => {});
    expect(setEnvelope).toHaveBeenCalledTimes(2);
    const baseline = setEnvelope.mock.calls[1]![3] as AutomationPoint[];
    expect(baseline.find((p) => p.id === "b")!.time).toBe(6);
    expect(lastSave().find((p) => p.id === "b")!.time).toBe(6.01);
  });

  it("lets go of a save that changed nothing after a pause", async () => {
    vi.useFakeTimers();
    try {
      const { finish } = await savedDrag("never");
      await finish();
      expect(point(2).getAttribute("aria-valuetext")).toContain("0:06");
      await act(async () => vi.advanceTimersByTime(1500));
      expect(point(2).getAttribute("aria-valuetext")).toContain("0:04");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LaneEnvelope on touch", () => {
  afterEach(() => useDawStore.setState({ pointerKind: "fine" }));

  it("saves a mouse drag of the same distance, so the touch case below differs by the finger", async () => {
    setup();
    const el = point(2);
    fireEvent.pointerDown(el, mouse(96, 20));
    fireEvent.pointerMove(el, mouse(130, 20));
    fireEvent.pointerUp(el, mouse(130, 20));
    await act(async () => {});
    expect(setEnvelope).toHaveBeenCalledTimes(1);
  });

  it("saves nothing for a finger that passed the slop without locking an axis", async () => {
    useDawStore.setState({ pointerKind: "coarse" });
    setup();
    const el = point(2);
    const finger = (x: number, y: number) => ({
      ...mouse(x, y),
      pointerType: "touch",
    });
    fireEvent.pointerDown(el, finger(96, 20));
    fireEvent.pointerMove(el, finger(130, 20));
    fireEvent.pointerUp(el, finger(130, 20));
    await act(async () => {});
    expect(hold).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(setEnvelope).not.toHaveBeenCalled();
    expect(stored().find((p) => p.id === "b")!.time).toBe(4);
  });
});

describe("LaneEnvelope dips", () => {
  it("guard: draws them from the finite points only", () => {
    putPoints([...POINTS, { id: "x", time: Number.NaN, value: 1 }]);
    const clip = clipRow({
      id: "c1",
      timeline_start: 0,
      timeline_end: 10,
      source_start: 0,
      fade_in_ms: 1000,
      fade_out_ms: 0,
    });
    setup(undefined, [clip]);
    const dip = screen.getByTestId("clip-gain-dip").querySelector("polyline")!;
    expect(dip.getAttribute("points")).not.toContain("NaN");
  });
});
