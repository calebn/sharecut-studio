import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updatePendingEdit } from "../api";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import type { PendingEditView } from "../types/project";
import { PendingEditOverlay } from "./PendingEditOverlay";
import { PendingEditOverlayView } from "./PendingEditOverlayView";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  updatePendingEdit: vi.fn(async () => undefined),
}));

const edit: PendingEditView = {
  id: "cut_1",
  track_id: "host",
  track_ids: ["host"],
  type: "remove",
  reason: "guest:suggest",
  source_start: 0,
  source_end: 2,
  timeline_start: 0,
  timeline_end: 2,
  timeline_spans: [{ start: 0, end: 2 }],
  mappable: true,
  crossfade_ms: 10,
  boundary_mode: null,
  cut_confidence: null,
  review_required: true,
  applied: false,
};

function setup(zoomPxPerSec: number, edits: PendingEditView[] = [edit]) {
  const onSelect = vi.fn();
  const view = render(
    <PendingEditOverlay
      edits={edits}
      trackId="host"
      zoomPxPerSec={zoomPxPerSec}
      selectedId={null}
      onSelect={onSelect}
    />,
  );
  return { onSelect, container: view.container };
}

describe("PendingEditOverlay handles", () => {
  beforeEach(() => {
    vi.mocked(updatePendingEdit).mockClear();
    HTMLElement.prototype.setPointerCapture = vi.fn();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("writes nothing when the 50 ms minimum clamps a drag back to the same bounds", () => {
    const tiny = {
      ...edit,
      source_end: 0.05,
      timeline_end: 0.05,
      timeline_spans: [{ start: 0, end: 0.05 }],
    };
    const { container } = setup(10, [tiny]);
    const start = container.querySelector(
      ".pending-handle.start",
    ) as HTMLElement;
    fireEvent.pointerDown(start, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(start, { clientX: 130, pointerId: 1 });
    fireEvent.pointerUp(start, { clientX: 130, pointerId: 1 });
    expect(updatePendingEdit).not.toHaveBeenCalled();
  });

  it("discards a drag that comes back to within 3 px of its start", () => {
    const { container } = setup(10);
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(end, { clientX: 140, pointerId: 1 });
    fireEvent.pointerUp(end, { clientX: 101, pointerId: 1 });
    expect(updatePendingEdit).not.toHaveBeenCalled();
  });

  it("selects on a pointer-up under 3 px and never updates", () => {
    const { onSelect, container } = setup(1.5);
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(end, { clientX: 102, pointerId: 1 });
    expect(onSelect).toHaveBeenCalledWith("cut_1");
    const start = container.querySelector(
      ".pending-handle.start",
    ) as HTMLElement;
    fireEvent.pointerDown(start, { clientX: 50, pointerId: 1 });
    fireEvent.pointerUp(start, { clientX: 50, pointerId: 1 });
    expect(updatePendingEdit).not.toHaveBeenCalled();
  });

  it("commits a drag of 3 px or more", () => {
    const { container } = setup(10);
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(end, { clientX: 130, pointerId: 1 });
    fireEvent.pointerUp(end, { clientX: 130, pointerId: 1 });
    expect(updatePendingEdit).toHaveBeenCalledTimes(1);
    const args = vi.mocked(updatePendingEdit).mock.calls[0];
    expect(args[0]).toBe("/tmp/p.json");
    expect(args[1]).toBe("cut_1");
    expect(args[2]).toBeCloseTo(0);
    expect(args[3]).toBeCloseTo(5);
    expect(args[4]).toBe(true);
  });
});

describe("PendingEditOverlayView", () => {
  it("renders from props and passes axe", async () => {
    const onSelect = vi.fn();
    const onCommitSpan = vi.fn();
    const { container } = render(
      <PendingEditOverlayView
        edits={[edit]}
        trackId="host"
        zoomPxPerSec={10}
        selectedId="cut_1"
        onSelect={onSelect}
        onCommitSpan={onCommitSpan}
      />,
    );
    expect(container.querySelector(".pending-overlay.selected")).not.toBeNull();
    expect(container.querySelector(".pending-overlay.remove")).not.toBeNull();
    const button = container.querySelector(
      'button[aria-label="Pending remove edit"]',
    ) as HTMLElement;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await expectNoA11yViolations(container);
  });

  it("commits an end-handle drag as mapped source seconds", () => {
    const onSelect = vi.fn();
    const onCommitSpan = vi.fn();
    const { container } = render(
      <PendingEditOverlayView
        edits={[edit]}
        trackId="host"
        zoomPxPerSec={10}
        selectedId={null}
        onSelect={onSelect}
        onCommitSpan={onCommitSpan}
      />,
    );
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(end, { clientX: 130, pointerId: 1 });
    fireEvent.pointerUp(end, { clientX: 130, pointerId: 1 });
    expect(onCommitSpan).toHaveBeenCalledWith("cut_1", 0, 5);
    expect(updatePendingEdit).not.toHaveBeenCalled();
  });

  it("survives a handle without pointer capture", () => {
    const original = (HTMLElement.prototype as { setPointerCapture?: unknown })
      .setPointerCapture;
    delete (HTMLElement.prototype as { setPointerCapture?: unknown })
      .setPointerCapture;
    try {
      const onSelect = vi.fn();
      const onCommitSpan = vi.fn();
      const { container } = render(
        <PendingEditOverlayView
          edits={[edit]}
          trackId="host"
          zoomPxPerSec={10}
          selectedId={null}
          onSelect={onSelect}
          onCommitSpan={onCommitSpan}
        />,
      );
      const end = container.querySelector(".pending-handle.end") as HTMLElement;
      expect(() =>
        fireEvent.pointerDown(end, { clientX: 100, pointerId: 1 }),
      ).not.toThrow();
      expect(onSelect).toHaveBeenCalledWith("cut_1");
    } finally {
      (
        HTMLElement.prototype as { setPointerCapture?: unknown }
      ).setPointerCapture = original;
    }
  });

  it("skips split handles", () => {
    const split = { ...edit, type: "split" };
    const onSelect = vi.fn();
    const onCommitSpan = vi.fn();
    const { container } = render(
      <PendingEditOverlayView
        edits={[split]}
        trackId="host"
        zoomPxPerSec={10}
        selectedId={null}
        onSelect={onSelect}
        onCommitSpan={onCommitSpan}
      />,
    );
    expect(container.querySelector(".pending-handle")).toBeNull();
  });
});
