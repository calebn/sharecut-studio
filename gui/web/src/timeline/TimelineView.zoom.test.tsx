import { act, fireEvent, render, screen } from "@testing-library/react";
import { Suspense, startTransition, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { minimalProject } from "../test/fixtures";
import { TimelineView } from "./TimelineView";
import { attachTimelineZoomGestures } from "./timelineZoomGestures";

const zoom = vi.hoisted(() => ({ ordinary: vi.fn(), fixed: vi.fn() }));
vi.mock("./timelineZoomGestures", () => ({
  attachTimelineZoomGestures: vi.fn(() => vi.fn()),
}));
vi.mock("./useFixedPlayheadScroll", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./useFixedPlayheadScroll")>();
  return {
    ...actual,
    useFixedPlayheadScroll: (
      inputs: Parameters<typeof actual.useFixedPlayheadScroll>[0],
    ) => ({
      ...actual.useFixedPlayheadScroll(inputs),
      applyZoomAt: inputs.fixedPlayhead ? zoom.fixed : zoom.ordinary,
    }),
  };
});
vi.mock("./TrackLane", () => ({ TrackLane: () => null }));

beforeEach(() => {
  zoom.ordinary.mockClear();
  zoom.fixed.mockClear();
  vi.mocked(attachTimelineZoomGestures).mockClear();
  useDawStore.getState().hydrate("/tmp/zoom-input.sharecut", minimalProject());
});

function currentDelegate() {
  const call = vi.mocked(attachTimelineZoomGestures).mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![1].applyZoomAt;
}

it("keeps an initial loading timeline zoom delegate silent", () => {
  useDawStore.setState({ project: null });
  render(<TimelineView fixedPlayhead />);
  expect(
    screen.getByRole("group", { name: "Loading timeline" }),
  ).toBeInTheDocument();
  act(() => currentDelegate()(40, 200));
  expect(zoom.ordinary).not.toHaveBeenCalled();
  expect(zoom.fixed).not.toHaveBeenCalled();
});

it("retains the last loaded delegate through a loading branch", () => {
  const view = render(<TimelineView />);
  act(() => currentDelegate()(40, 200));
  expect(zoom.ordinary).toHaveBeenCalledWith(40, 200);
  act(() => useDawStore.setState({ project: null }));
  view.rerender(<TimelineView fixedPlayhead />);
  expect(
    screen.getByRole("group", { name: "Loading timeline" }),
  ).toBeInTheDocument();
  act(() => currentDelegate()(60, 250));
  expect(zoom.ordinary).toHaveBeenLastCalledWith(60, 250);
  expect(zoom.fixed).not.toHaveBeenCalled();
});

it("publishes a replacement loaded delegate before the next gesture", () => {
  const view = render(<TimelineView />);
  act(() =>
    useDawStore
      .getState()
      .setProject(minimalProject({ timeline_duration_sec: 120 })),
  );
  view.rerender(<TimelineView fixedPlayhead />);
  act(() => currentDelegate()(80, 300));
  expect(zoom.fixed).toHaveBeenCalledWith(80, 300);
  expect(zoom.ordinary).not.toHaveBeenCalled();
});

it("keeps the committed zoom delegate through an attempted suspended layout", async () => {
  const pending = deferred();
  const consumed = vi.spyOn(pending.promise, "then");
  function Hold({ active }: { active: boolean }) {
    if (active) throw pending.promise;
    return <p>Committed ordinary timeline</p>;
  }
  function Host() {
    const [fixed, setFixed] = useState(false);
    return (
      <>
        <button
          type="button"
          onClick={() => startTransition(() => setFixed(true))}
        >
          Attempt fixed timeline
        </button>
        <Suspense fallback={<p>Loading replacement</p>}>
          <TimelineView fixedPlayhead={fixed} />
          <Hold active={fixed} />
        </Suspense>
      </>
    );
  }
  render(<Host />);
  const delegate = currentDelegate();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Attempt fixed timeline" }),
    );
  });
  expect(consumed).toHaveBeenCalled();
  expect(screen.getByText("Committed ordinary timeline")).toBeInTheDocument();
  expect(screen.queryByText("Loading replacement")).not.toBeInTheDocument();
  act(() => delegate(100, 350));
  expect(zoom.ordinary).toHaveBeenCalledWith(100, 350);
  expect(zoom.fixed).not.toHaveBeenCalled();
});
