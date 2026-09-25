import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { EnvelopeOverlay } from "./EnvelopeOverlay";
import { TimelineGestureProvider } from "./timelineMetrics";

const setEnvelope = vi.fn();

vi.mock("../api", () => ({
  setEnvelope: (...args: unknown[]) => setEnvelope(...args),
}));

function renderOverlay() {
  return render(
    <EnvelopeOverlay
      envelopes={useDawStore.getState().project?.envelopes ?? []}
      trackId="host"
      zoomPxPerSec={10}
      width={200}
      onSelectTrack={vi.fn()}
    />,
  );
}

describe("EnvelopeOverlay", () => {
  beforeEach(() => {
    setEnvelope.mockReset();
    setEnvelope.mockResolvedValue({});
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        envelopes: [
          {
            track_id: "host",
            parameter: "volume",
            points: [
              { id: "early", time: 0, value: 1 },
              { id: "late", time: 5, value: 0.5 },
            ],
          },
        ],
      }),
    );
    useDawStore.getState().setSelection(null);
  });

  it("selects a point on pointer down and highlights it", () => {
    const onSelectTrack = vi.fn();
    const { container } = render(
      <EnvelopeOverlay
        envelopes={useDawStore.getState().project?.envelopes ?? []}
        trackId="host"
        zoomPxPerSec={10}
        width={200}
        onSelectTrack={onSelectTrack}
      />,
    );
    const circles = container.querySelectorAll("circle");
    expect(circles.length).toBe(2);
    fireEvent.pointerDown(circles[1]!);
    expect(useDawStore.getState().selection).toEqual({
      kind: "envelopePoint",
      trackId: "host",
      index: 1,
    });
    expect(
      container.querySelector("circle.envelope-point-selected"),
    ).toBeTruthy();
    expect(onSelectTrack).not.toHaveBeenCalled();
  });

  it("does not SetEnvelope on a no-move click", async () => {
    const { container } = renderOverlay();
    const circle = container.querySelectorAll("circle")[1]!;
    fireEvent.pointerDown(circle);
    fireEvent.pointerUp(circle);
    await Promise.resolve();
    expect(setEnvelope).not.toHaveBeenCalled();
    expect(useDawStore.getState().selection).toEqual({
      kind: "envelopePoint",
      trackId: "host",
      index: 1,
    });
  });

  it("does not arm a second drag while SetEnvelope is in flight", async () => {
    let finish: (value: unknown) => void = () => {};
    setEnvelope.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { container } = renderOverlay();
    const circle = container.querySelectorAll("circle")[1]!;
    fireEvent.pointerDown(circle);
    fireEvent.pointerMove(circle, { clientX: 80, clientY: 8 });
    fireEvent.pointerUp(circle);
    await Promise.resolve();
    expect(setEnvelope).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(circle);
    fireEvent.pointerMove(circle, { clientX: 120, clientY: 8 });
    fireEvent.pointerUp(circle);
    await Promise.resolve();
    expect(setEnvelope).toHaveBeenCalledTimes(1);
    finish({});
    await Promise.resolve();
  });

  it("keeps a point DOM node when sorting changes during an edit", () => {
    const { container, rerender } = renderOverlay();
    const early = container.querySelectorAll("circle")[0]!;

    rerender(
      <EnvelopeOverlay
        envelopes={[
          {
            track_id: "host",
            parameter: "volume",
            points: [
              { id: "early", time: 10, value: 1 },
              { id: "late", time: 0, value: 0.5 },
            ],
          },
        ]}
        trackId="host"
        zoomPxPerSec={10}
        width={200}
        onSelectTrack={vi.fn()}
      />,
    );

    expect(container.querySelectorAll("circle")[1]).toBe(early);
    fireEvent.pointerDown(early);
    fireEvent.pointerMove(early, { clientX: 100, clientY: 8 });
    fireEvent.pointerUp(early);
    expect(setEnvelope).toHaveBeenCalledWith(
      "/tmp/p.json",
      "host",
      [
        { id: "late", time: 0, value: 0.5 },
        { id: "early", time: 10, value: 1.40625 },
      ],
      [
        { id: "late", time: 0, value: 0.5 },
        { id: "early", time: 10, value: 1 },
      ],
    );
  });

  it("clears a drag draft on pointer cancel", () => {
    const { container } = renderOverlay();
    const circle = container.querySelectorAll("circle")[1]!;
    fireEvent.pointerDown(circle);
    fireEvent.pointerCancel(circle);
    expect(setEnvelope).not.toHaveBeenCalled();
  });

  it("selects a point from the keyboard", () => {
    renderOverlay();
    fireEvent.keyDown(
      screen.getByRole("button", { name: /Envelope point 2/ }),
      {
        key: "Enter",
      },
    );
    expect(useDawStore.getState().selection).toEqual({
      kind: "envelopePoint",
      trackId: "host",
      index: 1,
    });
    expect(setEnvelope).not.toHaveBeenCalled();
  });

  it("selects the track on empty-lane hit, not a point", () => {
    const onSelectTrack = vi.fn();
    const { container } = render(
      <EnvelopeOverlay
        envelopes={useDawStore.getState().project?.envelopes ?? []}
        trackId="host"
        zoomPxPerSec={10}
        width={200}
        onSelectTrack={onSelectTrack}
      />,
    );
    fireEvent.click(container.querySelector(".envelope-hit")!);
    expect(onSelectTrack).toHaveBeenCalledTimes(1);
    expect(useDawStore.getState().selection).toBeNull();
  });

  it.each([
    [
      new Error("Envelope on track 'host' changed"),
      "Envelope on track 'host' changed",
    ],
    ["not an error", "Could not apply envelope"],
  ])(
    "rolls back the draft and selection when SetEnvelope rejects (%s)",
    async (rejection, announcement) => {
      setEnvelope.mockRejectedValue(rejection);
      const { container } = renderOverlay();
      const circle = container.querySelectorAll("circle")[1]!;
      const originalY = circle.getAttribute("cy");
      fireEvent.pointerDown(circle);
      fireEvent.pointerMove(circle, { clientX: 80, clientY: 8 });
      fireEvent.pointerUp(circle);
      await vi.waitFor(() =>
        expect(useDawStore.getState().statusAnnouncement).toBe(announcement),
      );
      expect(useDawStore.getState().selection).toBeNull();
      expect(container.querySelectorAll("circle")[1]!.getAttribute("cy")).toBe(
        originalY,
      );
    },
  );

  it("holds the lane geometry still for the length of a drag", async () => {
    const release = vi.fn();
    const hold = vi.fn(() => release);
    const { container } = render(
      <TimelineGestureProvider value={hold}>
        <EnvelopeOverlay
          envelopes={useDawStore.getState().project?.envelopes ?? []}
          trackId="host"
          zoomPxPerSec={10}
          width={200}
          onSelectTrack={vi.fn()}
        />
      </TimelineGestureProvider>,
    );
    const circle = container.querySelectorAll("circle")[1]!;
    fireEvent.pointerDown(circle);
    expect(hold).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(circle, { clientX: 80, clientY: 8 });
    expect(release).not.toHaveBeenCalled();
    fireEvent.pointerUp(circle);
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(hold).toHaveBeenCalledTimes(1);
  });

  it("draws only the viewport chunks of a deep-zoomed lane", () => {
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        envelopes: [
          {
            track_id: "host",
            parameter: "volume",
            points: [
              { id: "a", time: 0, value: 1 },
              { id: "b", time: 30, value: 0.5 },
              { id: "c", time: 30.01, value: 0.75 },
              { id: "d", time: 59, value: 1 },
            ],
          },
        ],
      }),
    );
    const zoom = 48000;
    // 30 s sits 100 px into a 1200 px view; chunk 703 starts at 1,439,744.
    useDawStore.setState({
      scrollLeft: 30 * zoom - 100,
      timelineViewportWidth: 1200,
    });
    const { container } = render(
      <EnvelopeOverlay
        envelopes={useDawStore.getState().project?.envelopes ?? []}
        trackId="host"
        zoomPxPerSec={zoom}
        width={60 * zoom}
        onSelectTrack={vi.fn()}
      />,
    );
    const x0 = 703 * 2048;
    const overlay = container.querySelector(".envelope-overlay") as HTMLElement;
    expect(parseFloat(overlay.style.left)).toBe(x0);
    expect(parseFloat(overlay.style.width)).toBe(2048);
    const circles = [...container.querySelectorAll("circle")];
    expect(circles.map((c) => Number(c.getAttribute("cx")))).toEqual([
      30 * zoom - x0,
      30.01 * zoom - x0,
    ]);
    // The line runs to the off-screen neighbours on both sides.
    const line = container.querySelector("polyline")!.getAttribute("points")!;
    expect(line.split(" ")).toHaveLength(4);
    expect(line.startsWith(`${-x0},`)).toBe(true);
    useDawStore.setState({ scrollLeft: 0, timelineViewportWidth: 0 });
  });
});
