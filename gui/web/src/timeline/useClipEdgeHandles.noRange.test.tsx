import { fireEvent, render } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { noRangeProject } from "../test/timedTrimLane";
import { trimNeighborBounds } from "../utils/trimLimits";
import { useClipEdgeHandles } from "./useClipEdgeHandles";

function Harness() {
  const lane = useDawStore((s) => s.project?.clips.tracks.host) ?? [];
  const bounds = trimNeighborBounds(lane, 0, "ripple");
  const h = useClipEdgeHandles({
    clip: lane[0]!,
    trackId: "host",
    neighborSourceLo: bounds.neighborLo,
    neighborSourceHi: bounds.neighborHi,
    zoomPxPerSec: 50,
    getTicks: () => [],
    onSelect: () => {},
  });
  return (
    <button
      onPointerDown={(e) => h.onPointerDown("trim-out", e)}
      onPointerMove={h.onPointerMove}
      onPointerUp={h.onPointerUp}
    >
      {h.trimPreview ? "previewing" : "idle"}
    </button>
  );
}

const drag = (button: HTMLElement) => {
  fireEvent.pointerDown(button, { pointerId: 1, clientX: 150 });
  fireEvent.pointerMove(button, { pointerId: 1, clientX: 100 });
};

beforeEach(() => {
  useDawStore.getState().hydrate("/tmp/ep.json", noRangeProject());
});

it("starts no trim drag on an edge a timing correction leaves no legal range", () => {
  const view = render(<Harness />);
  drag(view.getByRole("button"));
  expect(view.getByRole("button").textContent).toBe("idle");
});

it("still drags the same edge once the correction is gone", () => {
  useDawStore.getState().hydrate("/tmp/ep.json", noRangeProject(false));
  const view = render(<Harness />);
  drag(view.getByRole("button"));
  expect(view.getByRole("button").textContent).toBe("previewing");
});
