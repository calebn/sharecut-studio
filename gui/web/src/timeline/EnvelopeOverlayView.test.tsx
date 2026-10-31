import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { place } from "../test/hitDom";
import type { AutomationPoint } from "../types/project";
import { EnvelopeOverlayView } from "./EnvelopeOverlayView";
import { resolveHits } from "./hitTargets";

const points: AutomationPoint[] = [
  { id: "early", time: 0, value: 1 },
  { id: "late", time: 5, value: 0.5 },
];

function renderView(
  overrides: Partial<Parameters<typeof EnvelopeOverlayView>[0]> = {},
) {
  const onSelectTrack = vi.fn();
  const onSelectPoint = vi.fn();
  const onCommitPoints = vi.fn().mockResolvedValue({});
  const onCommitError = vi.fn();
  const release = vi.fn();
  const holdGeometry = vi.fn(() => release);
  const utils = render(
    <EnvelopeOverlayView
      points={points}
      baselinePoints={points}
      zoomPxPerSec={10}
      width={200}
      height={72}
      visibleChunks={[0, 0]}
      editable
      selectedPointId={null}
      onSelectTrack={onSelectTrack}
      captureSelection={() => onSelectPoint}
      onCommitPoints={onCommitPoints}
      onCommitError={onCommitError}
      holdGeometry={holdGeometry}
      {...overrides}
    />,
  );
  return {
    ...utils,
    onSelectTrack,
    onSelectPoint,
    onCommitPoints,
    onCommitError,
    holdGeometry,
    release,
  };
}

function capture(circle: SVGElement) {
  let pointer: number | null = null;
  const release = vi.fn((pointerId: number) => {
    pointer = null;
    fireEvent.lostPointerCapture(circle, { pointerId });
  });
  Object.assign(circle, {
    setPointerCapture: vi.fn((pointerId: number) => {
      pointer = pointerId;
    }),
    hasPointerCapture: (pointerId: number) => pointer === pointerId,
    releasePointerCapture: release,
  });
  return release;
}

describe("EnvelopeOverlayView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.onkeydown = null;
  });

  it("shows a focusable empty line without saving, then commits one pair from its exact empty origin", async () => {
    const { container, onCommitPoints, holdGeometry, release } = renderView({
      points: [],
      baselinePoints: [],
      timelineEnd: 20,
    });
    const line = screen.getByRole("slider", { name: "Envelope level" });
    expect(line).toHaveAttribute("aria-valuenow", "1");
    expect(onCommitPoints).not.toHaveBeenCalled();
    capture(line as unknown as SVGElement);
    fireEvent.pointerDown(line, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientY: 30,
    });
    fireEvent.pointerMove(line, { pointerId: 1, clientY: 46 });
    expect(line).toHaveAttribute("aria-valuenow", "0.625");
    fireEvent.pointerUp(line, { pointerId: 1 });
    await vi.waitFor(() => expect(onCommitPoints).toHaveBeenCalledTimes(1));
    const [next, origin] = onCommitPoints.mock.calls[0]!;
    expect(origin).toEqual([]);
    expect(next).toMatchObject([
      { time: 0, value: 0.625 },
      { time: 20, value: 0.625 },
    ]);
    expect(next[0].id).not.toBe(next[1].id);
    expect(holdGeometry).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    await expectNoA11yViolations(container);
  });

  it("preserves saved flat point order and ignores a shaped line", async () => {
    const flat = [
      { id: "late", time: 5, value: 0.5 },
      { id: "early", time: 0, value: 0.5 },
    ];
    const { onCommitPoints, rerender } = renderView({
      points: [...flat].reverse(),
      baselinePoints: flat,
      timelineEnd: 10,
    });
    const line = screen.getByRole("slider", { name: "Envelope level" });
    fireEvent.keyDown(line, { key: "ArrowUp" });
    expect(line).toHaveAttribute("aria-valuenow", "0.51");
    fireEvent.keyUp(line, { key: "ArrowUp" });
    await vi.waitFor(() => expect(onCommitPoints).toHaveBeenCalledTimes(1));
    expect(onCommitPoints).toHaveBeenCalledWith(
      [
        { id: "late", time: 5, value: 0.51 },
        { id: "early", time: 0, value: 0.51 },
      ],
      flat,
    );
    rerender(
      <EnvelopeOverlayView
        points={points}
        baselinePoints={points}
        zoomPxPerSec={10}
        width={200}
        height={72}
        visibleChunks={[0, 0]}
        editable
        selectedPointId={null}
        onSelectTrack={vi.fn()}
        captureSelection={() => vi.fn()}
        onCommitPoints={onCommitPoints}
        onCommitError={vi.fn()}
      />,
    );
    expect(screen.queryByRole("slider", { name: "Envelope level" })).toBeNull();
  });

  it("cancels an unsubmitted line draft on Escape and a competing baseline", () => {
    const { rerender, onCommitPoints } = renderView({
      points: [],
      baselinePoints: [],
      timelineEnd: 10,
    });
    const line = screen.getByRole("slider", { name: "Envelope level" });
    fireEvent.keyDown(line, { key: "ArrowDown" });
    fireEvent.keyDown(line, { key: "Escape" });
    fireEvent.keyUp(line, { key: "ArrowDown" });
    expect(onCommitPoints).not.toHaveBeenCalled();
    fireEvent.keyDown(line, { key: "ArrowDown" });
    rerender(
      <EnvelopeOverlayView
        points={[{ id: "new", time: 0, value: 0.7 }]}
        baselinePoints={[{ id: "new", time: 0, value: 0.7 }]}
        zoomPxPerSec={10}
        width={200}
        height={72}
        visibleChunks={[0, 0]}
        editable
        selectedPointId={null}
        onSelectTrack={vi.fn()}
        captureSelection={() => vi.fn()}
        onCommitPoints={onCommitPoints}
        onCommitError={vi.fn()}
      />,
    );
    fireEvent.keyUp(line, { key: "ArrowDown" });
    expect(onCommitPoints).not.toHaveBeenCalled();
  });

  it("does not save a click or an empty line returned to unity", () => {
    const { onCommitPoints } = renderView({
      points: [],
      baselinePoints: [],
      timelineEnd: 10,
    });
    const line = screen.getByRole("slider", { name: "Envelope level" });
    fireEvent.pointerDown(line, { pointerId: 1, clientY: 30 });
    fireEvent.pointerUp(line, { pointerId: 1 });
    fireEvent.keyDown(line, { key: "ArrowDown" });
    fireEvent.keyDown(line, { key: "ArrowUp" });
    fireEvent.keyUp(line, { key: "ArrowUp" });
    expect(onCommitPoints).not.toHaveBeenCalled();
  });

  it("selects another track on a plain line tap without saving", () => {
    const selected = vi.fn();
    const save = vi.fn().mockResolvedValue({});
    const { container } = renderView({
      points: [],
      baselinePoints: [],
      timelineEnd: 10,
      onSelectTrack: selected,
      onCommitPoints: save,
    });
    const line = container.querySelector(".envelope-line-target")!;
    fireEvent.pointerDown(line, { pointerId: 1, clientY: 30 });
    fireEvent.pointerUp(line, { pointerId: 1 });
    fireEvent.click(line, { detail: 1 });
    expect(selected).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("routes the next point press to that point after editing the flat line", () => {
    const flat = [
      { id: "start", time: 0, value: 0.5 },
      { id: "next", time: 5, value: 0.5 },
    ];
    const { container, onCommitPoints } = renderView({
      points: flat,
      baselinePoints: flat,
    });
    const overlay = container.querySelector(".envelope-overlay")!;
    const line = container.querySelector(".envelope-line-target")!;
    const point = container.querySelectorAll(
      '[data-hit-kind="envelope-point"]',
    )[1];
    place(line, { left: 100, top: 114, right: 400, bottom: 126 });
    place(point, { left: 195, top: 115, right: 205, bottom: 125 });
    fireEvent.pointerDown(line, { pointerId: 1, clientY: 120 });
    fireEvent.pointerUp(line, { pointerId: 1, clientY: 120 });
    expect(document.activeElement).toBe(line);
    expect(
      resolveHits(overlay, { x: 203, y: 116 }, "mouse", point)[0].candidate
        .kind,
    ).toBe("envelope-point");
    expect(onCommitPoints).not.toHaveBeenCalled();
  });

  it("does not select a track from a drag's trailing click or a read-only guide", async () => {
    const { container, onSelectTrack, onCommitPoints, rerender } = renderView({
      points: [],
      baselinePoints: [],
      timelineEnd: 10,
    });
    const line = container.querySelector(".envelope-line-target")!;
    fireEvent.pointerDown(line, { pointerId: 4, clientY: 30 });
    fireEvent.pointerMove(line, { pointerId: 4, clientY: 20 });
    fireEvent.pointerUp(line, { pointerId: 4, clientY: 20 });
    fireEvent.click(line, { detail: 1 });
    await vi.waitFor(() => expect(onCommitPoints).toHaveBeenCalledTimes(1));
    expect(onSelectTrack).not.toHaveBeenCalled();
    rerender(
      <EnvelopeOverlayView
        points={[]}
        baselinePoints={[]}
        timelineEnd={10}
        zoomPxPerSec={10}
        width={200}
        height={72}
        visibleChunks={[0, 0]}
        editable={false}
        selectedPointId={null}
        onSelectTrack={onSelectTrack}
        captureSelection={() => vi.fn()}
        onCommitPoints={onCommitPoints}
        onCommitError={vi.fn()}
      />,
    );
    const guide = screen.getByRole("slider", { name: "Envelope level" });
    expect(guide).not.toHaveAttribute("data-hit-kind");
    fireEvent.click(guide);
    expect(onSelectTrack).not.toHaveBeenCalled();
  });

  it("cancels an unsubmitted line pointer gesture without rolling back an accepted command", async () => {
    let resolveCommit: (value: unknown) => void = () => {};
    const onCommitPoints = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCommit = resolve;
        }),
    );
    const { rerender } = renderView({
      points: [],
      baselinePoints: [],
      timelineEnd: 10,
      onCommitPoints,
    });
    const line = screen.getByRole("slider", { name: "Envelope level" });
    fireEvent.pointerDown(line, { pointerId: 1, clientY: 30 });
    fireEvent.pointerMove(line, { pointerId: 1, clientY: 46 });
    fireEvent.pointerCancel(line, { pointerId: 1 });
    expect(onCommitPoints).not.toHaveBeenCalled();
    fireEvent.pointerDown(line, { pointerId: 2, clientY: 30 });
    fireEvent.pointerMove(line, { pointerId: 2, clientY: 46 });
    fireEvent.pointerUp(line, { pointerId: 2 });
    expect(onCommitPoints).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(line, { pointerId: 3, clientY: 30 });
    fireEvent.pointerMove(line, { pointerId: 3, clientY: 46 });
    fireEvent.pointerUp(line, { pointerId: 3 });
    expect(onCommitPoints).toHaveBeenCalledTimes(1);
    rerender(
      <EnvelopeOverlayView
        points={points}
        baselinePoints={points}
        zoomPxPerSec={10}
        width={200}
        height={72}
        visibleChunks={[0, 0]}
        editable
        selectedPointId={null}
        onSelectTrack={vi.fn()}
        captureSelection={() => vi.fn()}
        onCommitPoints={onCommitPoints}
        onCommitError={vi.fn()}
      />,
    );
    await act(async () => resolveCommit({}));
    expect(onCommitPoints).toHaveBeenCalledTimes(1);
  });

  it("uses distinct touch identities for different flat lines and leaves a read-only guide inert", () => {
    const props = {
      points: [] as AutomationPoint[],
      baselinePoints: [] as AutomationPoint[],
      timelineEnd: 10,
      zoomPxPerSec: 10,
      width: 200,
      height: 72,
      visibleChunks: [0, 0] as const,
      selectedPointId: null,
      onSelectTrack: vi.fn(),
      captureSelection: () => vi.fn(),
      onCommitPoints: vi.fn().mockResolvedValue({}),
      onCommitError: vi.fn(),
    };
    const { container } = render(
      <>
        <EnvelopeOverlayView {...props} editable />
        <EnvelopeOverlayView {...props} editable />
        <EnvelopeOverlayView {...props} editable={false} />
      </>,
    );
    const lines = [...container.querySelectorAll(".envelope-svg rect")];
    expect(lines).toHaveLength(3);
    expect(lines[0]!.getAttribute("data-hit-id")).not.toBe(
      lines[1]!.getAttribute("data-hit-id"),
    );
    expect(lines[0]).toHaveAttribute("data-hit-kind", "envelope-line");
    expect(lines[1]).toHaveAttribute("data-hit-kind", "envelope-line");
    expect(lines[2]).not.toHaveAttribute("data-hit-kind");
    expect(lines[2]).toHaveAttribute("aria-disabled", "true");
    expect(lines[2]).toHaveAttribute("tabindex", "-1");
  });

  it("renders named points with an accessible label and no axe violations", async () => {
    const { container } = renderView();
    const circles = container.querySelectorAll("circle");
    expect(circles).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: /Envelope point 1/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Envelope point 2/ }),
    ).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("draws a selected point at radius 7 and a read-only point at radius 2.5", () => {
    const { container, rerender } = renderView({ selectedPointId: "late" });
    const circles = [...container.querySelectorAll("circle")];
    expect(circles[1]!.getAttribute("r")).toBe("7");

    rerender(
      <EnvelopeOverlayView
        points={points}
        baselinePoints={points}
        zoomPxPerSec={10}
        width={200}
        height={72}
        visibleChunks={[0, 0]}
        editable={false}
        selectedPointId={null}
        onSelectTrack={vi.fn()}
        captureSelection={() => vi.fn()}
        onCommitPoints={vi.fn().mockResolvedValue({})}
        onCommitError={vi.fn()}
      />,
    );
    const readOnlyCircles = [...container.querySelectorAll("circle")];
    expect(readOnlyCircles[0]!.getAttribute("r")).toBe("2.5");
  });

  it("selects a point from the keyboard without committing", () => {
    const { onSelectPoint, onCommitPoints } = renderView();
    fireEvent.keyDown(
      screen.getByRole("button", { name: /Envelope point 2/ }),
      { key: "Enter" },
    );
    expect(onSelectPoint).toHaveBeenCalledWith("late");
    expect(onCommitPoints).not.toHaveBeenCalled();
  });

  it("selects a point on no-op release without changing selection during preview", () => {
    const { container, onSelectPoint, onCommitPoints } = renderView();
    const circle = container.querySelectorAll("circle")[1]!;
    fireEvent.pointerDown(circle);
    expect(onSelectPoint).not.toHaveBeenCalled();
    expect(circle).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(circle, { key: "Enter" });
    fireEvent.keyDown(circle, { key: " " });
    expect(onSelectPoint).not.toHaveBeenCalled();
    fireEvent.pointerUp(circle);
    expect(onSelectPoint).toHaveBeenCalledExactlyOnceWith("late");
    expect(onCommitPoints).not.toHaveBeenCalled();
  });

  it("commits the exact re-sorted points and origin on a drag, then selects the moved point", async () => {
    const { container, onCommitPoints, onSelectPoint, holdGeometry, release } =
      renderView();
    const circle = container.querySelectorAll("circle")[0]!;
    fireEvent.pointerDown(circle);
    expect(holdGeometry).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(circle, { clientX: 65, clientY: 8 });
    fireEvent.pointerUp(circle);
    await vi.waitFor(() => expect(onCommitPoints).toHaveBeenCalledTimes(1));
    expect(onCommitPoints).toHaveBeenCalledWith(
      [
        { id: "late", time: 5, value: 0.5 },
        { id: "early", time: 6.5, value: 1.40625 },
      ],
      [
        { id: "early", time: 0, value: 1 },
        { id: "late", time: 5, value: 0.5 },
      ],
    );
    await vi.waitFor(() => expect(onSelectPoint).toHaveBeenCalledWith("early"));
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(holdGeometry).toHaveBeenCalledTimes(1);
  });

  it("engages the geometry hold inside pointerdown, before any effect flush", () => {
    const { container, holdGeometry } = renderView();
    const circle = container.querySelectorAll("circle")[0]!;
    let callsDuringEvent = -1;
    act(() => {
      fireEvent.pointerDown(circle);
      callsDuringEvent = holdGeometry.mock.calls.length;
    });
    expect(callsDuringEvent).toBe(1);
  });

  it("releases the hold on pointercancel", () => {
    const { container, release } = renderView();
    const circle = container.querySelectorAll("circle")[0]!;
    fireEvent.pointerDown(circle);
    fireEvent.pointerCancel(circle);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the hold when a press ends without moving", () => {
    const { container, release, onCommitPoints } = renderView();
    const circle = container.querySelectorAll("circle")[0]!;
    fireEvent.pointerDown(circle);
    fireEvent.pointerUp(circle);
    expect(release).toHaveBeenCalledTimes(1);
    expect(onCommitPoints).not.toHaveBeenCalled();
  });

  it("releases the hold when the view unmounts mid-drag", () => {
    const { container, release, unmount } = renderView();
    const circle = container.querySelectorAll("circle")[0]!;
    const releaseCapture = capture(circle);
    fireEvent.pointerDown(circle, { pointerId: 1 });
    expect(release).not.toHaveBeenCalled();
    unmount();
    expect(release).toHaveBeenCalledTimes(1);
    expect(releaseCapture).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("restores cy and calls onCommitError when a commit rejects", async () => {
    const onCommitPoints = vi.fn().mockRejectedValue(new Error("nope"));
    const { container, onCommitError } = renderView({ onCommitPoints });
    const circle = container.querySelectorAll("circle")[1]!;
    const originalCy = circle.getAttribute("cy");
    fireEvent.pointerDown(circle);
    fireEvent.pointerMove(circle, { clientX: 80, clientY: 8 });
    fireEvent.pointerUp(circle);
    await vi.waitFor(() => expect(onCommitError).toHaveBeenCalled());
    expect(container.querySelectorAll("circle")[1]!.getAttribute("cy")).toBe(
      originalCy,
    );
  });

  it("does not arm a second drag while a commit is in flight", async () => {
    let finish: (value: unknown) => void = () => {};
    const onCommitPoints = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { container, release } = renderView({ onCommitPoints });
    const circle = container.querySelectorAll("circle")[1]!;
    const releaseCapture = capture(circle);
    fireEvent.pointerDown(circle);
    fireEvent.pointerMove(circle, { clientX: 80, clientY: 8 });
    fireEvent.pointerUp(circle);
    expect(onCommitPoints).toHaveBeenCalledTimes(1);
    const pendingCy = circle.getAttribute("cy");
    fireEvent.keyDown(circle, { key: "Escape" });
    act(() => {
      circle.blur();
    });
    expect(circle.getAttribute("cy")).toBe(pendingCy);
    expect(release).not.toHaveBeenCalled();
    expect(releaseCapture).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(circle);
    fireEvent.pointerMove(circle, { clientX: 120, clientY: 8 });
    fireEvent.pointerUp(circle);
    expect(onCommitPoints).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({});
    });
    expect(onCommitPoints).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("focuses the owner without scrolling and Escape restores its preview before release", () => {
    const { container, onCommitPoints, release } = renderView();
    const circle = container.querySelectorAll("circle")[0]!;
    const releaseCapture = capture(circle);
    const focus = vi.spyOn(circle, "focus");
    const original = {
      cx: circle.getAttribute("cx"),
      cy: circle.getAttribute("cy"),
    };
    const parentKey = vi.fn();
    document.body.onkeydown = parentKey;
    fireEvent.pointerDown(circle, { pointerId: 1 });
    expect(document.activeElement).toBe(circle);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    fireEvent.pointerMove(circle, { pointerId: 1, clientX: 65, clientY: 8 });
    expect(circle.getAttribute("cx")).toBe("65");
    expect(fireEvent.keyDown(circle, { key: "Escape" })).toBe(false);
    expect(parentKey).not.toHaveBeenCalled();
    expect({
      cx: circle.getAttribute("cx"),
      cy: circle.getAttribute("cy"),
    }).toEqual(original);
    expect(releaseCapture).toHaveBeenCalledExactlyOnceWith(1);
    expect(release).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(circle, { pointerId: 1 });
    expect(onCommitPoints).not.toHaveBeenCalled();
    fireEvent.pointerDown(circle, { pointerId: 2 });
    fireEvent.pointerMove(circle, { pointerId: 2, clientX: 65, clientY: 8 });
    fireEvent.pointerUp(circle, { pointerId: 2 });
    expect(onCommitPoints).toHaveBeenCalledExactlyOnceWith(
      [
        { id: "late", time: 5, value: 0.5 },
        { id: "early", time: 6.5, value: 1.40625 },
      ],
      points,
    );
  });

  it.each([
    "pointerDown",
    "pointerMove",
    "pointerUp",
    "pointerCancel",
    "lostPointerCapture",
  ] as const)(
    "ignores foreign %s while retaining the owner's draft and geometry hold",
    (event) => {
      const {
        container,
        onCommitPoints,
        onSelectPoint,
        holdGeometry,
        release,
      } = renderView();
      const [owner, other] = [...container.querySelectorAll("circle")];
      capture(owner!);
      fireEvent.pointerDown(owner!, { pointerId: 1 });
      fireEvent.pointerMove(owner!, { pointerId: 1, clientX: 65, clientY: 8 });
      fireEvent[event](other!, { pointerId: 99, clientX: 120, clientY: 60 });
      expect(owner!.getAttribute("cx")).toBe("65");
      expect(owner!.getAttribute("cy")).toBe("8");
      expect(document.activeElement).toBe(owner);
      expect(onSelectPoint).not.toHaveBeenCalled();
      expect(holdGeometry).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
      expect(onCommitPoints).not.toHaveBeenCalled();
      fireEvent.pointerUp(owner!, { pointerId: 1 });
      expect(onCommitPoints).toHaveBeenCalledExactlyOnceWith(
        [
          { id: "late", time: 5, value: 0.5 },
          { id: "early", time: 6.5, value: 1.40625 },
        ],
        points,
      );
    },
  );

  it("cancels on actual focus departure without moving focus back", () => {
    const { container, onCommitPoints, release } = renderView();
    const circle = container.querySelectorAll("circle")[0]!;
    const releaseCapture = capture(circle);
    const other = document.createElement("button");
    container.appendChild(other);
    fireEvent.pointerDown(circle, { pointerId: 1 });
    fireEvent.pointerMove(circle, { pointerId: 1, clientX: 65, clientY: 8 });
    act(() => {
      other.focus();
    });
    expect(document.activeElement).toBe(other);
    expect(circle.getAttribute("cx")).toBe("0");
    expect(releaseCapture).toHaveBeenCalledExactlyOnceWith(1);
    expect(release).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(circle, { pointerId: 1 });
    expect(onCommitPoints).not.toHaveBeenCalled();
  });

  it.each([1, 2])(
    "rejects mouse button %s before selecting or acquiring a drag",
    (button) => {
      const { container, onSelectPoint, holdGeometry, onCommitPoints } =
        renderView();
      const circle = container.querySelectorAll("circle")[0]!;
      fireEvent.pointerDown(circle, {
        pointerId: 1,
        pointerType: "mouse",
        button,
      });
      fireEvent.pointerMove(circle, { pointerId: 1, clientX: 65, clientY: 8 });
      fireEvent.pointerUp(circle, { pointerId: 1 });
      expect(onSelectPoint).not.toHaveBeenCalled();
      expect(holdGeometry).not.toHaveBeenCalled();
      expect(onCommitPoints).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(circle);
    },
  );

  it.each(["pointerCancel", "lostPointerCapture"] as const)(
    "restores owner geometry and makes release inert after %s",
    (event) => {
      const { container, onCommitPoints, release } = renderView();
      const circle = container.querySelectorAll("circle")[0]!;
      capture(circle);
      fireEvent.pointerDown(circle, { pointerId: 1 });
      fireEvent.pointerMove(circle, { pointerId: 1, clientX: 65, clientY: 8 });
      fireEvent[event](circle, { pointerId: 1 });
      expect(circle.getAttribute("cx")).toBe("0");
      fireEvent.pointerUp(circle, { pointerId: 1 });
      expect(onCommitPoints).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("does not admit a preview if the circle cannot acquire focus", () => {
    const { container, onCommitPoints, holdGeometry } = renderView();
    const circle = container.querySelectorAll("circle")[0]!;
    vi.spyOn(circle, "focus").mockImplementation(() => {});
    fireEvent.pointerDown(circle, { pointerId: 1 });
    fireEvent.pointerMove(circle, { pointerId: 1, clientX: 65, clientY: 8 });
    fireEvent.pointerUp(circle, { pointerId: 1 });
    expect(holdGeometry).not.toHaveBeenCalled();
    expect(onCommitPoints).not.toHaveBeenCalled();
    expect(circle.getAttribute("cx")).toBe("0");
  });

  it("releases geometry and restores the point if capture setup fails", () => {
    const { container, onCommitPoints, onCommitError, release } = renderView();
    const circle = container.querySelectorAll("circle")[0]!;
    capture(circle);
    const error = new Error("Pointer is no longer active");
    vi.spyOn(circle, "setPointerCapture").mockImplementationOnce(() => {
      throw error;
    });
    fireEvent.pointerDown(circle, { pointerId: 1 });
    fireEvent.pointerMove(circle, { pointerId: 1, clientX: 65, clientY: 8 });
    fireEvent.pointerUp(circle, { pointerId: 1 });
    expect(onCommitError).toHaveBeenCalledExactlyOnceWith(error);
    expect(release).toHaveBeenCalledTimes(1);
    expect(onCommitPoints).not.toHaveBeenCalled();
    expect(circle.getAttribute("cx")).toBe("0");
    fireEvent.pointerDown(circle, { pointerId: 2 });
    fireEvent.pointerMove(circle, { pointerId: 2, clientX: 65, clientY: 8 });
    fireEvent.pointerUp(circle, { pointerId: 2 });
    expect(onCommitPoints).toHaveBeenCalledTimes(1);
  });

  it("keeps read-only pointer and Enter/Space selection without admitting edits", () => {
    const { container, onSelectPoint, onCommitPoints, holdGeometry } =
      renderView({ editable: false });
    const circle = container.querySelectorAll("circle")[1]!;
    fireEvent.pointerDown(circle, { pointerId: 1 });
    fireEvent.pointerMove(circle, { pointerId: 1, clientX: 65, clientY: 8 });
    fireEvent.pointerUp(circle, { pointerId: 1 });
    fireEvent.keyDown(circle, { key: "Enter" });
    fireEvent.keyDown(circle, { key: " " });
    expect(onSelectPoint.mock.calls).toEqual([["late"], ["late"], ["late"]]);
    expect(onCommitPoints).not.toHaveBeenCalled();
    expect(holdGeometry).not.toHaveBeenCalled();
  });
  it("draws only the deep-zoom viewport chunk", () => {
    const zoom = 48000;
    const deepPoints: AutomationPoint[] = [
      { id: "a", time: 0, value: 1 },
      { id: "b", time: 30, value: 0.5 },
      { id: "c", time: 30.01, value: 0.75 },
      { id: "d", time: 59, value: 1 },
    ];
    const { container } = renderView({
      points: deepPoints,
      zoomPxPerSec: zoom,
      width: 60 * zoom,
      visibleChunks: [703, 703],
    });
    const x0 = 703 * 2048;
    const circles = [...container.querySelectorAll("circle")];
    expect(circles.map((c) => Number(c.getAttribute("cx")))).toEqual([
      30 * zoom - x0,
      30.01 * zoom - x0,
    ]);
    const line = container.querySelector("polyline")!.getAttribute("points")!;
    expect(line.split(" ")).toHaveLength(4);
  });

  it("renders only a unity baseline for an empty points array", () => {
    const { container } = renderView({ points: [] });
    const line = container.querySelector("polyline");
    expect(line?.getAttribute("points")).toBe(
      "0,25.333333333333336 200,25.333333333333336",
    );
    expect(container.querySelectorAll("circle")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Envelope point/ })).toBeNull();
  });

  it("skips selection after a commit that resolves once unmounted", async () => {
    let resolve!: (v: unknown) => void;
    const onCommitPoints = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const { container, onSelectPoint, release, unmount } = renderView({
      onCommitPoints,
    });
    const circle = container.querySelectorAll("circle")[0]!;
    fireEvent.pointerDown(circle);
    fireEvent.pointerMove(circle, { clientX: 65, clientY: 8 });
    fireEvent.pointerUp(circle);
    expect(onCommitPoints).toHaveBeenCalledTimes(1);
    unmount();
    expect(release).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({});
    });
    expect(onSelectPoint).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("skips the error callback after a commit that rejects once unmounted", async () => {
    let reject!: (e: unknown) => void;
    const onCommitPoints = vi.fn(
      () =>
        new Promise((_, rj) => {
          reject = rj;
        }),
    );
    const { container, onCommitError, unmount } = renderView({
      onCommitPoints,
    });
    const circle = container.querySelectorAll("circle")[0]!;
    fireEvent.pointerDown(circle);
    fireEvent.pointerMove(circle, { clientX: 65, clientY: 8 });
    fireEvent.pointerUp(circle);
    unmount();
    await act(async () => {
      reject(new Error("gone"));
    });
    expect(onCommitError).not.toHaveBeenCalled();
  });
});

it("captures the raw saved ordering at pointerdown, independently of display order", () => {
  const raw = [points[1]!, points[0]!];
  const { container, onCommitPoints } = renderView({ baselinePoints: raw });
  const circle = container.querySelectorAll("circle")[1]!;
  fireEvent.pointerDown(circle, { pointerId: 31 });
  raw.reverse();
  fireEvent.pointerMove(circle, { pointerId: 31, clientX: 80, clientY: 8 });
  fireEvent.pointerUp(circle, { pointerId: 31 });
  expect(onCommitPoints).toHaveBeenCalledWith(
    [
      { id: "early", time: 0, value: 1 },
      { id: "late", time: 8, value: 1.40625 },
    ],
    [points[1], points[0]],
  );
});
it("rejects a drag that introduces a new coincident timestamp", () => {
  const { container, onCommitPoints, onCommitError, release } = renderView();
  const circle = container.querySelectorAll("circle")[1]!;
  fireEvent.pointerDown(circle, { pointerId: 31 });
  fireEvent.pointerMove(circle, { pointerId: 31, clientX: 0, clientY: 8 });
  fireEvent.pointerUp(circle, { pointerId: 31 });
  expect(onCommitPoints).not.toHaveBeenCalled();
  expect(onCommitError).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining("already exists"),
    }),
  );
  expect(release).toHaveBeenCalledTimes(1);
});

it("releases ownership when the held point disappears while the view remains mounted", () => {
  const release = vi.fn();
  const onCommitPoints = vi.fn().mockResolvedValue(undefined);
  const props = {
    points,
    baselinePoints: points,
    zoomPxPerSec: 10,
    width: 200,
    height: 72,
    visibleChunks: [0, 0] as const,
    editable: true,
    selectedPointId: null,
    onSelectTrack: vi.fn(),
    captureSelection: () => vi.fn(),
    onCommitPoints,
    onCommitError: vi.fn(),
    holdGeometry: () => release,
  };
  const { container, rerender, unmount } = render(
    <EnvelopeOverlayView {...props} />,
  );
  const circle = container.querySelectorAll("circle")[1]!;
  const releaseCapture = vi.fn();
  circle.hasPointerCapture = () => true;
  circle.releasePointerCapture = releaseCapture;
  fireEvent.pointerDown(circle, { pointerId: 91 });
  fireEvent.pointerMove(circle, { pointerId: 91, clientX: 80, clientY: 8 });
  rerender(<EnvelopeOverlayView {...props} points={[]} baselinePoints={[]} />);
  expect(container.querySelector("circle")).toBeNull();
  expect(release).toHaveBeenCalledTimes(1);
  expect(releaseCapture).toHaveBeenCalledWith(91);
  fireEvent.pointerUp(circle, { pointerId: 91 });
  expect(onCommitPoints).not.toHaveBeenCalled();
  unmount();
  expect(release).toHaveBeenCalledTimes(1);
});

it("draws clip fades read-only, labelled, and leaves the envelope line alone", () => {
  const { container } = renderView({
    clipDips: [
      {
        clipId: "c1",
        points: [
          { time: 1, gain: 0 },
          { time: 2, gain: 1 },
        ],
      },
    ],
  });

  const dip = screen.getByTestId("clip-gain-dip");
  expect(dip).toHaveAttribute("pointer-events", "none");
  expect(dip).toHaveAttribute("aria-hidden", "true");
  expect(dip).toHaveTextContent("clip fade");
  expect(dip.querySelector("polyline")).toHaveAttribute(
    "points",
    expect.stringContaining("10,"),
  );
  expect(container.querySelectorAll("circle")).toHaveLength(points.length);
});

it("keeps two dips that start at the same time apart", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  renderView({
    clipDips: [
      {
        clipId: "c1",
        points: [
          { time: 1, gain: 0 },
          { time: 2, gain: 1 },
        ],
      },
      {
        clipId: "c1",
        points: [
          { time: 1, gain: 0 },
          { time: 3, gain: 0 },
        ],
      },
    ],
  });

  expect(screen.getAllByTestId("clip-gain-dip")).toHaveLength(2);
  expect(error).not.toHaveBeenCalled();
  error.mockRestore();
});
