import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import type { AutomationPoint } from "../types/project";
import { EnvelopeOverlayView } from "./EnvelopeOverlayView";

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
      zoomPxPerSec={10}
      width={200}
      height={72}
      visibleChunks={[0, 0]}
      editable
      selectedIndex={null}
      onSelectTrack={onSelectTrack}
      onSelectPoint={onSelectPoint}
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

describe("EnvelopeOverlayView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
    const { container, rerender } = renderView({ selectedIndex: 1 });
    const circles = [...container.querySelectorAll("circle")];
    expect(circles[1]!.getAttribute("r")).toBe("7");

    rerender(
      <EnvelopeOverlayView
        points={points}
        zoomPxPerSec={10}
        width={200}
        height={72}
        visibleChunks={[0, 0]}
        editable={false}
        selectedIndex={null}
        onSelectTrack={vi.fn()}
        onSelectPoint={vi.fn()}
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
    expect(onSelectPoint).toHaveBeenCalledWith(1);
    expect(onCommitPoints).not.toHaveBeenCalled();
  });

  it("selects a point on pointer down without committing", () => {
    const { container, onSelectPoint, onCommitPoints } = renderView();
    const circle = container.querySelectorAll("circle")[1]!;
    fireEvent.pointerDown(circle);
    expect(onSelectPoint).toHaveBeenCalledWith(1);
    fireEvent.pointerUp(circle);
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
    await vi.waitFor(() => expect(onSelectPoint).toHaveBeenCalledWith(1));
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
    fireEvent.pointerDown(circle);
    expect(release).not.toHaveBeenCalled();
    unmount();
    expect(release).toHaveBeenCalledTimes(1);
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
    const { container } = renderView({ onCommitPoints });
    const circle = container.querySelectorAll("circle")[1]!;
    fireEvent.pointerDown(circle);
    fireEvent.pointerMove(circle, { clientX: 80, clientY: 8 });
    fireEvent.pointerUp(circle);
    expect(onCommitPoints).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(circle);
    fireEvent.pointerMove(circle, { clientX: 120, clientY: 8 });
    fireEvent.pointerUp(circle);
    expect(onCommitPoints).toHaveBeenCalledTimes(1);
    finish({});
    await vi.waitFor(() => expect(onCommitPoints).toHaveBeenCalledTimes(1));
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

  it("renders nothing for an empty points array", () => {
    const { container } = renderView({ points: [] });
    expect(container).toBeEmptyDOMElement();
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
    expect(onSelectPoint).toHaveBeenCalledTimes(1);
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
