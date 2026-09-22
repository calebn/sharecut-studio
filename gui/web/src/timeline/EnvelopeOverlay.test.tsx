import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { EnvelopeOverlay } from "./EnvelopeOverlay";

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
});
