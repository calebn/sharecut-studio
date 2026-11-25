import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { skipProject } from "../test/timedTrimLane";
import { trimNeighborBounds } from "../utils/trimLimits";
import { precisionDriver } from "./precision/precisionDrivers";
import { useClipEdgeHandles } from "./useClipEdgeHandles";

function Harness({ handle }: { handle: "trim-in" | "trim-out" }) {
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
  const p = h.trimPreview;
  return (
    <button
      onPointerDown={(e) => h.onPointerDown(handle, e)}
      onPointerMove={h.onPointerMove}
      onPointerUp={h.onPointerUp}
    >
      {p ? `${p.sourceStart}|${p.sourceEnd}` : "idle"}
    </button>
  );
}

const label = (view: ReturnType<typeof render>) =>
  view.getByRole("button").textContent;

beforeEach(() => {
  useDawStore.getState().hydrate("/tmp/ep.json", skipProject());
});

describe("a trim drag stops at the clip's timing corrections", () => {
  it("holds a contracting out edge at the skip's end", () => {
    const view = render(<Harness handle="trim-out" />);
    const b = view.getByRole("button");
    fireEvent.pointerDown(b, { pointerId: 1, clientX: 500 });
    // 9 s back: source 11, well before the correction at 15.
    fireEvent.pointerMove(b, { pointerId: 1, clientX: 50 });
    expect(label(view)).toBe("10|15.500001");
  });

  it("holds a contracting in edge before the first correction", () => {
    const view = render(<Harness handle="trim-in" />);
    const b = view.getByRole("button");
    fireEvent.pointerDown(b, { pointerId: 1, clientX: 100 });
    // 9 s forward: source 19, past the correction at 15.
    fireEvent.pointerMove(b, { pointerId: 1, clientX: 550 });
    expect(label(view)).toBe("14.999999|20");
  });

  it("holds the precision field the same way", () => {
    const view = render(<Harness handle="trim-out" />);
    const field = { kind: "trim", trackId: "host", clipId: "a", edge: "out" };
    const driver = precisionDriver(
      "trim-out",
      "a",
      field as never,
      "Trim out",
    )!;
    act(() => {
      driver.begin();
      driver.show(11);
    });
    expect(label(view)).toBe("10|15.500001");
  });

  it("drops a drag whose limits changed under it", () => {
    const view = render(<Harness handle="trim-out" />);
    const b = view.getByRole("button");
    fireEvent.pointerDown(b, { pointerId: 1, clientX: 500 });
    // The correction goes away while the handle is held: the capture is stale.
    act(() => {
      const project = skipProject();
      const clip = project.clips.tracks.host![0]!;
      delete clip.timing;
      useDawStore.getState().hydrate("/tmp/ep.json", project);
    });
    fireEvent.pointerMove(b, { pointerId: 1, clientX: 50 });
    expect(label(view)).toBe("idle");
  });
});
