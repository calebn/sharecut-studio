import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updatePendingEdit } from "../api";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { PendingEditView } from "../types/project";
import { PendingEditOverlay } from "./PendingEditOverlay";

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

function setup(zoomPxPerSec: number) {
  const onSelect = vi.fn();
  const view = render(
    <PendingEditOverlay
      edits={[edit]}
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
