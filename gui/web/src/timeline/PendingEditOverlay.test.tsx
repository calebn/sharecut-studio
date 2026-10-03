import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updatePendingEdit, waiveTranscriptRefine } from "../api";
import { useWaveformSnapTicks } from "../hooks/useWaveformSnapTicks";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { clipRow, minimalProject } from "../test/fixtures";
import type { PendingEditView } from "../types/project";
import { ApiError, TRANSCRIPT_REFINE_REQUIRED_CODE } from "../utils/apiError";
import { PENDING_REVIEW_QUEUED_MESSAGE } from "../utils/pendingEditLabels";
import { pendingEditTimingFieldId } from "../utils/pendingEditTimingField";
import { PendingEditOverlay } from "./PendingEditOverlay";
import { PendingEditOverlayView } from "./PendingEditOverlayView";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  updatePendingEdit: vi.fn(async () => undefined),
  waiveTranscriptRefine: vi.fn(async () => undefined),
}));
vi.mock("../hooks/useWaveformSnapTicks", () => ({
  useWaveformSnapTicks: vi.fn(() => ({
    ticks: [],
    resolveTicks: vi.fn(async () => []),
  })),
}));

function snapResource(ticks: number[]) {
  return { ticks, resolveTicks: vi.fn(async () => ticks) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const edit: PendingEditView = {
  id: "cut_1",
  track_id: "host",
  track_ids: ["host"],
  type: "remove",
  reason: "guest:suggest",
  source_start: 0,
  source_end: 2,
  source_start_timeline: 0,
  source_end_timeline: 2,
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
      timelineWidthPx={1000}
      selectedId={null}
      onSelect={onSelect}
    />,
  );
  return { onSelect, container: view.container };
}

describe("PendingEditOverlay handles", () => {
  beforeEach(() => {
    vi.mocked(updatePendingEdit).mockClear();
    vi.mocked(waiveTranscriptRefine).mockClear();
    vi.mocked(useWaveformSnapTicks).mockReturnValue(snapResource([]));
    HTMLElement.prototype.setPointerCapture = vi.fn();
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ pending_edits: [edit] }));
  });

  it.each([null, "edit"])(
    "presents exact islands without source handles or guest review in mode %s",
    async (guestMode) => {
      const exact = {
        ...edit,
        source_start: null,
        source_end: null,
        source_start_timeline: null,
        source_end_timeline: null,
        timeline_start: 11,
        timeline_end: 14,
        timeline_spans: [
          { start: 11, end: 12 },
          { start: 13, end: 14 },
        ],
        exact_range: {
          kind: "exact_range" as const,
          intervals: [
            { start: 11, end: 12 },
            { start: 13, end: 14 },
          ],
          track_ids: ["host", "guest"],
          clips: [],
          media_seals: { host: "seal", guest: "seal" },
        },
      };
      useDawStore
        .getState()
        .hydrate("/tmp/p.json", minimalProject({ pending_edits: [exact] }));
      useDawStore.setState({
        guestMode,
        shareCapabilities: ["edit"],
        selection: { kind: "pending", id: exact.id, trackId: "host" },
      });
      const { container } = render(
        <PendingEditOverlay
          edits={[exact]}
          trackId="host"
          zoomPxPerSec={20}
          timelineWidthPx={1000}
          selectedId={exact.id}
          onSelect={vi.fn()}
        />,
      );
      expect(container.querySelectorAll(".pending-overlay")).toHaveLength(2);
      expect(container.querySelector(".pending-handle")).toBeNull();
      expect(
        screen.getAllByRole("button", {
          name: /0:11.000 – 0:12.000 · 0:13.000 – 0:14.000 · host, guest/,
        }).length,
      ).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "Edit timing" })).toBeNull();
      await waitFor(() => {
        const buttons = screen.getAllByRole("button", { name: "Approve" });
        for (const button of buttons) {
          if (guestMode === null) expect(button).toBeEnabled();
          else expect(button).toBeDisabled();
        }
      });
      expect(updatePendingEdit).not.toHaveBeenCalled();
    },
  );

  it("writes nothing when the 50 ms minimum clamps a drag back to the same bounds", () => {
    const tiny = {
      ...edit,
      source_end: 0.05,
      source_end_timeline: 0.05,
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

  it("opens the pending inspector from the native edge button keyboard path", async () => {
    const user = userEvent.setup();
    const { onSelect, container } = setup(10);
    const start = container.querySelector(
      ".pending-handle.start",
    ) as HTMLButtonElement;
    const hintId = start.getAttribute("aria-describedby");
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId!)).toHaveTextContent(
      "use Source start or Source end for keyboard adjustment",
    );
    start.focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("cut_1");
    expect(updatePendingEdit).not.toHaveBeenCalled();
  });

  it("Edit timing focuses the selected inspector source field", async () => {
    const field = document.createElement("input");
    field.id = pendingEditTimingFieldId("cut_1", "start");
    field.scrollIntoView = vi.fn();
    document.body.appendChild(field);
    useDawStore
      .getState()
      .setSelection({ kind: "pending", id: "cut_1", trackId: "host" });
    render(
      <PendingEditOverlayView
        edits={[edit]}
        trackId="host"
        zoomPxPerSec={10}
        timelineWidthPx={1000}
        selectedId="cut_1"
        projectPath="/tmp/p.json"
        clipsByTrack={{}}
        canAdjust
        canApply
        onSelect={vi.fn()}
        onCommitSpan={vi.fn()}
        onReviewAction={vi.fn(async () => ({ queued: false }))}
      />,
    );
    const timingButton = document.querySelector(
      ".pending-timing-action",
    ) as HTMLButtonElement;
    fireEvent.click(timingButton);
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    field.remove();
  });

  it("shows coarse edge handles only when the selected region and lane fit them", async () => {
    document.documentElement.style.setProperty("--touch-min", "2.75rem");
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 200,
        bottom: 96,
        width: 200,
        height: 96,
        toJSON: () => ({}),
      });
    useDawStore.setState({ pointerKind: "coarse" });
    const wideEdit = {
      ...edit,
      source_end: 10,
      source_end_timeline: 10,
      timeline_end: 10,
      timeline_spans: [{ start: 0, end: 10 }],
    };
    const view = render(
      <PendingEditOverlayView
        edits={[wideEdit]}
        trackId="host"
        zoomPxPerSec={10}
        timelineWidthPx={1000}
        selectedId="cut_1"
        projectPath="/tmp/p.json"
        clipsByTrack={{
          host: [
            clipRow({
              id: "origin",
              track_id: "host",
              source_start: 0,
              source_end: 20,
              timeline_start: 0,
              timeline_end: 20,
            }),
          ],
        }}
        canAdjust
        canApply
        onSelect={vi.fn()}
        onCommitSpan={vi.fn()}
        onReviewAction={vi.fn(async () => ({ queued: false }))}
      />,
    );
    const region = view.container.querySelector(
      ".pending-overlay",
    ) as HTMLElement;
    await waitFor(() =>
      expect(region).toHaveAttribute("data-coarse-handles", "ready"),
    );
    expect(region.style.getPropertyValue("--pending-handle-half-width")).toBe(
      "22px",
    );
    rect.mockRestore();
    document.documentElement.style.removeProperty("--touch-min");
  });

  it("omits Edit timing when the selected edit cannot be adjusted", () => {
    const { container } = render(
      <PendingEditOverlayView
        edits={[edit]}
        trackId="host"
        zoomPxPerSec={10}
        timelineWidthPx={1000}
        selectedId="cut_1"
        projectPath="/tmp/p.json"
        clipsByTrack={{}}
        canAdjust={false}
        canApply
        onSelect={vi.fn()}
        onCommitSpan={vi.fn()}
        onReviewAction={vi.fn(async () => ({ queued: false }))}
      />,
    );
    expect(container.querySelector(".pending-timing-action")).toBeNull();
  });

  it("commits a drag of 3 px or more after resolving snap ticks", async () => {
    vi.mocked(useWaveformSnapTicks).mockReturnValue(snapResource([]));
    const { container } = setup(10);
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(end, { clientX: 130, pointerId: 1 });
    fireEvent.pointerUp(end, { clientX: 130, pointerId: 1 });
    await waitFor(() => expect(updatePendingEdit).toHaveBeenCalledTimes(1));
    const args = vi.mocked(updatePendingEdit).mock.calls[0];
    expect(args[0]).toBe("/tmp/p.json");
    expect(args[1]).toBe("cut_1");
    expect(args[2]).toBeCloseTo(0);
    expect(args[3]).toBeCloseTo(5);
    expect(args[4]).toBe(false);
  });

  it("commits the bounded raw range when a successful final lookup has no ticks", async () => {
    vi.mocked(useWaveformSnapTicks).mockReturnValue(snapResource([]));
    const { container } = setup(10);
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 2 });
    fireEvent.pointerMove(end, { clientX: 130, pointerId: 2 });
    fireEvent.pointerUp(end, { clientX: 130, pointerId: 2 });
    await waitFor(() =>
      expect(updatePendingEdit).toHaveBeenCalledWith(
        "/tmp/p.json",
        "cut_1",
        0,
        5,
        false,
      ),
    );
  });

  it("commits the resolved snap exactly and preserves the stationary edge", async () => {
    vi.mocked(useWaveformSnapTicks).mockReturnValue(snapResource([4.3]));
    const { container } = setup(10);
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 3 });
    fireEvent.pointerMove(end, { clientX: 130, pointerId: 3 });
    fireEvent.pointerUp(end, { clientX: 130, pointerId: 3 });
    await waitFor(() =>
      expect(updatePendingEdit).toHaveBeenCalledWith(
        "/tmp/p.json",
        "cut_1",
        0,
        4.3,
        false,
      ),
    );
  });

  it("keeps the preview while resolving ticks, ignores release capture loss, then commits once", async () => {
    const pending = deferred<number[]>();
    const resolveTicks = vi.fn(
      (_focusSec: number, _signal: AbortSignal) => pending.promise,
    );
    vi.mocked(useWaveformSnapTicks).mockReturnValue({
      ticks: [],
      resolveTicks,
    });
    const onCommitSpan = vi.fn(() => undefined);
    const { container } = render(
      <PendingEditOverlayView
        edits={[edit]}
        trackId="host"
        zoomPxPerSec={10}
        timelineWidthPx={1000}
        selectedId="cut_1"
        projectPath="/tmp/p.json"
        clipsByTrack={{}}
        canAdjust
        canApply
        onSelect={vi.fn()}
        onCommitSpan={() => {
          expect(
            (container.querySelector(".pending-overlay") as HTMLElement).style
              .width,
          ).toBe("43px");
          onCommitSpan();
        }}
        onReviewAction={vi.fn(async () => ({ queued: false }))}
      />,
    );
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 21 });
    fireEvent.pointerMove(end, { clientX: 130, pointerId: 21 });
    fireEvent.pointerUp(end, { clientX: 130, pointerId: 21 });
    expect(screen.getByRole("status", { hidden: true })).toHaveTextContent(
      "Checking nearby snap points",
    );
    expect(resolveTicks).toHaveBeenCalledWith(5, expect.any(AbortSignal));
    fireEvent.lostPointerCapture(end, { pointerId: 21 });
    expect(onCommitSpan).not.toHaveBeenCalled();
    await act(async () => pending.resolve([4.3]));
    await waitFor(() => expect(onCommitSpan).toHaveBeenCalledOnce());
  });

  it("shows a retryable error and does not commit when final snap loading fails", async () => {
    vi.mocked(useWaveformSnapTicks).mockReturnValue({
      ticks: [],
      resolveTicks: vi.fn(async () => {
        throw new Error("network offline");
      }),
    });
    const onCommitSpan = vi.fn();
    const { container } = render(
      <PendingEditOverlayView
        edits={[edit]}
        trackId="host"
        zoomPxPerSec={10}
        timelineWidthPx={1000}
        selectedId="cut_1"
        projectPath="/tmp/p.json"
        clipsByTrack={{}}
        canAdjust
        canApply
        onSelect={vi.fn()}
        onCommitSpan={onCommitSpan}
        onReviewAction={vi.fn(async () => ({ queued: false }))}
      />,
    );
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 22 });
    fireEvent.pointerMove(end, { clientX: 130, pointerId: 22 });
    fireEvent.pointerUp(end, { clientX: 130, pointerId: 22 });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Nearby waveform snap points could not be loaded. Try again.",
    );
    expect(onCommitSpan).not.toHaveBeenCalled();
    expect(updatePendingEdit).not.toHaveBeenCalled();
  });

  it("aborts a settling drag when Escape cancels the focused edge", async () => {
    const pending = deferred<number[]>();
    const resolveTicks = vi.fn(
      (_focusSec: number, _signal: AbortSignal) => pending.promise,
    );
    vi.mocked(useWaveformSnapTicks).mockReturnValue({
      ticks: [],
      resolveTicks,
    });
    const onCommitSpan = vi.fn();
    const { container } = render(
      <PendingEditOverlayView
        edits={[edit]}
        trackId="host"
        zoomPxPerSec={10}
        timelineWidthPx={1000}
        selectedId={null}
        projectPath="/tmp/p.json"
        clipsByTrack={{}}
        canAdjust
        canApply
        onSelect={vi.fn()}
        onCommitSpan={onCommitSpan}
        onReviewAction={vi.fn(async () => ({ queued: false }))}
      />,
    );
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 23 });
    fireEvent.pointerMove(end, { clientX: 130, pointerId: 23 });
    fireEvent.pointerUp(end, { clientX: 130, pointerId: 23 });
    fireEvent.keyDown(end, { key: "Escape" });
    expect(resolveTicks.mock.calls.at(0)?.[1]?.aborted).toBe(true);
    await act(async () => pending.resolve([4.3]));
    expect(onCommitSpan).not.toHaveBeenCalled();
    expect(updatePendingEdit).not.toHaveBeenCalled();
  });

  it("aborts a settling drag when the selected edit is cleared", async () => {
    const pending = deferred<number[]>();
    const resolveTicks = vi.fn(
      (_focusSec: number, _signal: AbortSignal) => pending.promise,
    );
    vi.mocked(useWaveformSnapTicks).mockReturnValue({
      ticks: [],
      resolveTicks,
    });
    const onCommitSpan = vi.fn();
    const props = {
      edits: [edit],
      trackId: "host",
      zoomPxPerSec: 10,
      timelineWidthPx: 1000,
      projectPath: "/tmp/p.json",
      clipsByTrack: {},
      canAdjust: true,
      canApply: true,
      onSelect: vi.fn(),
      onCommitSpan,
      onReviewAction: vi.fn(async () => ({ queued: false })),
    };
    const view = render(
      <PendingEditOverlayView {...props} selectedId="cut_1" />,
    );
    const end = view.container.querySelector(
      ".pending-handle.end",
    ) as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 24 });
    fireEvent.pointerMove(end, { clientX: 130, pointerId: 24 });
    fireEvent.pointerUp(end, { clientX: 130, pointerId: 24 });
    expect(resolveTicks).toHaveBeenCalledOnce();
    view.rerender(<PendingEditOverlayView {...props} selectedId={null} />);
    expect(resolveTicks.mock.calls.at(0)?.[1]?.aborted).toBe(true);
    await act(async () => pending.resolve([4.3]));
    expect(onCommitSpan).not.toHaveBeenCalled();
    expect(updatePendingEdit).not.toHaveBeenCalled();
  });

  it("aborts settling immediately when the same project path changes epoch", async () => {
    const pending = deferred<number[]>();
    const resolveTicks = vi.fn(
      (_focusSec: number, _signal: AbortSignal) => pending.promise,
    );
    vi.mocked(useWaveformSnapTicks).mockReturnValue({
      ticks: [],
      resolveTicks,
    });
    const onCommitSpan = vi.fn();
    const { container } = render(
      <PendingEditOverlayView
        edits={[edit]}
        trackId="host"
        zoomPxPerSec={10}
        timelineWidthPx={1000}
        selectedId={null}
        projectPath="/tmp/p.json"
        clipsByTrack={{}}
        canAdjust
        canApply
        onSelect={vi.fn()}
        onCommitSpan={onCommitSpan}
        onReviewAction={vi.fn(async () => ({ queued: false }))}
      />,
    );
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 25 });
    fireEvent.pointerMove(end, { clientX: 130, pointerId: 25 });
    fireEvent.pointerUp(end, { clientX: 130, pointerId: 25 });
    const signal = resolveTicks.mock.calls.at(0)?.[1];
    expect(signal).toBeDefined();
    useDawStore.setState((state) => ({ projectEpoch: state.projectEpoch + 1 }));
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await act(async () => pending.resolve([4.3]));
    expect(onCommitSpan).not.toHaveBeenCalled();
    expect(updatePendingEdit).not.toHaveBeenCalled();
  });

  it("cancels on pointercancel and ignores another pointer id", () => {
    const { container } = setup(10);
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 4 });
    fireEvent.pointerMove(end, { clientX: 140, pointerId: 5 });
    fireEvent.pointerUp(end, { clientX: 140, pointerId: 5 });
    fireEvent.pointerCancel(end, { pointerId: 4 });
    expect(updatePendingEdit).not.toHaveBeenCalled();
  });

  it("drops a captured drag after the project epoch changes", () => {
    const { container } = setup(10);
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 6 });
    useDawStore
      .getState()
      .hydrate("/tmp/next.json", minimalProject({ pending_edits: [edit] }));
    fireEvent.pointerMove(end, { clientX: 130, pointerId: 6 });
    fireEvent.pointerUp(end, { clientX: 130, pointerId: 6 });
    expect(updatePendingEdit).not.toHaveBeenCalled();
  });

  it("drops a drag when the pending edit bounds changed before release", () => {
    const { container } = setup(10);
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 7 });
    useDawStore.getState().setProject(
      minimalProject({
        pending_edits: [{ ...edit, source_end: 2.5 }],
      }),
    );
    fireEvent.pointerMove(end, { clientX: 130, pointerId: 7 });
    fireEvent.pointerUp(end, { clientX: 130, pointerId: 7 });
    expect(updatePendingEdit).not.toHaveBeenCalled();
  });
});

describe("PendingEditOverlayView", () => {
  beforeEach(() => {
    vi.mocked(useWaveformSnapTicks).mockReturnValue(snapResource([]));
    HTMLElement.prototype.setPointerCapture = vi.fn();
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ pending_edits: [edit] }));
  });

  const selectPending = () =>
    useDawStore.getState().setSelection({
      kind: "pending",
      id: edit.id,
      trackId: edit.track_id,
    });

  it("renders from props and passes axe", async () => {
    const onSelect = vi.fn();
    const onCommitSpan = vi.fn();
    const { container } = render(
      <PendingEditOverlayView
        edits={[edit]}
        trackId="host"
        zoomPxPerSec={10}
        timelineWidthPx={1000}
        selectedId="cut_1"
        projectPath="/tmp/p.json"
        clipsByTrack={{}}
        canAdjust
        canApply
        onSelect={onSelect}
        onCommitSpan={onCommitSpan}
        onReviewAction={vi.fn(async () => ({ queued: false }))}
      />,
    );
    expect(container.querySelector(".pending-overlay.selected")).not.toBeNull();
    expect(container.querySelector(".pending-overlay.remove")).not.toBeNull();
    const button = container.querySelector(
      'button[aria-label="Pending remove edit, Cut 2.0s · suggested"]',
    ) as HTMLElement;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await expectNoA11yViolations(container);
  });

  it("commits an end-handle drag as mapped source seconds", async () => {
    const onSelect = vi.fn();
    const onCommitSpan = vi.fn();
    const { container } = render(
      <PendingEditOverlayView
        edits={[edit]}
        trackId="host"
        zoomPxPerSec={10}
        timelineWidthPx={1000}
        selectedId={null}
        projectPath="/tmp/p.json"
        clipsByTrack={{}}
        canAdjust
        canApply
        onSelect={onSelect}
        onCommitSpan={onCommitSpan}
        onReviewAction={vi.fn(async () => ({ queued: false }))}
      />,
    );
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(end, { clientX: 130, pointerId: 1 });
    fireEvent.pointerUp(end, { clientX: 130, pointerId: 1 });
    await waitFor(() =>
      expect(onCommitSpan).toHaveBeenCalledWith(
        "/tmp/p.json",
        expect.any(Number),
        "cut_1",
        0,
        2,
        0,
        5,
      ),
    );
    expect(updatePendingEdit).not.toHaveBeenCalled();
  });

  it("cancels a settling drag when its origin clip placement changes", async () => {
    let resolveTicks!: (ticks: number[]) => void;
    vi.mocked(useWaveformSnapTicks).mockReturnValue({
      ticks: [],
      resolveTicks: vi.fn(
        () =>
          new Promise<number[]>((resolve) => {
            resolveTicks = resolve;
          }),
      ),
    });
    const originClip = clipRow({
      track_id: "host",
      source_start: 0,
      source_end: 10,
      timeline_start: 0,
      timeline_end: 10,
    });
    useDawStore.getState().setProject(
      minimalProject({
        pending_edits: [edit],
        clips: { tracks: { host: [originClip] }, clip_count: 1 },
      }),
    );
    const onCommitSpan = vi.fn();
    const onSelect = vi.fn();
    const { container } = render(
      <PendingEditOverlayView
        edits={[edit]}
        trackId="host"
        zoomPxPerSec={10}
        timelineWidthPx={1000}
        selectedId="cut_1"
        projectPath="/tmp/p.json"
        clipsByTrack={{ host: [originClip] }}
        canAdjust
        canApply
        onSelect={onSelect}
        onCommitSpan={onCommitSpan}
        onReviewAction={vi.fn(async () => ({ queued: false }))}
      />,
    );
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 20, pointerId: 3 });
    expect(onSelect).toHaveBeenCalledWith("cut_1");
    fireEvent.pointerMove(end, { clientX: 30, pointerId: 3 });
    fireEvent.pointerUp(end, { clientX: 30, pointerId: 3 });
    expect(
      vi.mocked(useWaveformSnapTicks).mock.results.at(-1)?.value.resolveTicks,
    ).toHaveBeenCalled();
    expect(
      await screen.findByText("Checking nearby snap points…"),
    ).toBeInTheDocument();

    await act(async () => {
      useDawStore.getState().setProject(
        minimalProject({
          pending_edits: [edit],
          clips: {
            tracks: {
              host: [{ ...originClip, timeline_start: 1, timeline_end: 11 }],
            },
            clip_count: 1,
          },
        }),
      );
    });
    await waitFor(() =>
      expect(screen.queryByText("Checking nearby snap points…")).toBeNull(),
    );
    await act(async () => {
      resolveTicks([]);
    });
    await waitFor(() =>
      expect(screen.queryByText("Checking nearby snap points…")).toBeNull(),
    );
    expect(onCommitSpan).not.toHaveBeenCalled();
    expect(updatePendingEdit).not.toHaveBeenCalled();
  });

  it("does not start a drag when pointer capture is unavailable", () => {
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
          timelineWidthPx={1000}
          selectedId={null}
          projectPath="/tmp/p.json"
          clipsByTrack={{}}
          canAdjust
          canApply
          onSelect={onSelect}
          onCommitSpan={onCommitSpan}
          onReviewAction={vi.fn(async () => ({ queued: false }))}
        />,
      );
      const end = container.querySelector(".pending-handle.end") as HTMLElement;
      expect(() =>
        fireEvent.pointerDown(end, { clientX: 100, pointerId: 1 }),
      ).not.toThrow();
      fireEvent.pointerMove(end, { clientX: 130, pointerId: 1 });
      fireEvent.pointerUp(end, { clientX: 130, pointerId: 1 });
      expect(onSelect).not.toHaveBeenCalled();
      expect(onCommitSpan).not.toHaveBeenCalled();
    } finally {
      (
        HTMLElement.prototype as { setPointerCapture?: unknown }
      ).setPointerCapture = original;
    }
  });

  it("shows tiny pending labels on hover instead of at the timeline origin", async () => {
    const { container } = render(
      <PendingEditOverlayView
        edits={[edit]}
        trackId="host"
        zoomPxPerSec={10}
        timelineWidthPx={1000}
        selectedId={null}
        projectPath="/tmp/p.json"
        clipsByTrack={{}}
        canAdjust
        canApply
        onSelect={vi.fn()}
        onCommitSpan={vi.fn()}
        onReviewAction={vi.fn(async () => ({ queued: false }))}
      />,
    );
    expect(document.body.querySelector(".pending-label--floating")).toBeNull();
    fireEvent.pointerEnter(
      container.querySelector(".pending-hit") as HTMLElement,
    );
    await waitFor(() =>
      expect(
        document.body.querySelector(".pending-label--floating"),
      ).not.toBeNull(),
    );
  });

  it("keeps a minimum end-edge hit target inside the timeline width", () => {
    const endCut = {
      ...edit,
      source_start: 59.9,
      source_end: 60,
      source_start_timeline: 59.9,
      source_end_timeline: 60,
      timeline_start: 59.9,
      timeline_end: 60,
      timeline_spans: [{ start: 59.9, end: 60 }],
    };
    const { container } = render(
      <PendingEditOverlayView
        edits={[endCut]}
        trackId="host"
        zoomPxPerSec={20}
        selectedId={null}
        projectPath="/tmp/p.json"
        timelineWidthPx={1200}
        clipsByTrack={{}}
        canAdjust
        canApply
        onSelect={vi.fn()}
        onCommitSpan={vi.fn()}
        onReviewAction={vi.fn(async () => ({ queued: false }))}
      />,
    );
    const region = container.querySelector(".pending-overlay") as HTMLElement;
    expect(region.style.left).toBe("1194px");
    expect(region.style.width).toBe("12px");
    expect(region.style.getPropertyValue("--pending-region-offset")).toBe(
      "5px",
    );
    expect(region.style.getPropertyValue("--pending-handle-start-offset")).toBe(
      "-10px",
    );
    expect(region.style.getPropertyValue("--pending-handle-end-offset")).toBe(
      "-4px",
    );
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
        timelineWidthPx={1000}
        selectedId={null}
        projectPath="/tmp/p.json"
        clipsByTrack={{}}
        canAdjust
        canApply
        onSelect={onSelect}
        onCommitSpan={onCommitSpan}
        onReviewAction={vi.fn(async () => ({ queued: false }))}
      />,
    );
    expect(container.querySelector(".pending-handle")).toBeNull();
  });

  it("shows queued review feedback and keeps the selected region", async () => {
    selectPending();
    const onReviewAction = vi.fn(async () => ({ queued: true }));
    render(
      <PendingEditOverlayView
        edits={[edit]}
        trackId="host"
        zoomPxPerSec={10}
        timelineWidthPx={1000}
        selectedId="cut_1"
        projectPath="/tmp/p.json"
        clipsByTrack={{}}
        canAdjust
        canApply
        onSelect={vi.fn()}
        onCommitSpan={vi.fn()}
        onReviewAction={onReviewAction}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve" })).toBeVisible(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(
      await screen.findByText(PENDING_REVIEW_QUEUED_MESSAGE),
    ).toBeInTheDocument();
    expect(onReviewAction).toHaveBeenCalledWith(
      "/tmp/p.json",
      expect.any(Number),
      "cut_1",
      "approve",
    );
    expect(document.querySelector(".pending-overlay.selected")).not.toBeNull();
  });

  it("shows review failures as an alert", async () => {
    selectPending();
    render(
      <PendingEditOverlayView
        edits={[edit]}
        trackId="host"
        zoomPxPerSec={10}
        timelineWidthPx={1000}
        selectedId="cut_1"
        projectPath="/tmp/p.json"
        clipsByTrack={{}}
        canAdjust
        canApply
        onSelect={vi.fn()}
        onCommitSpan={vi.fn()}
        onReviewAction={vi.fn(async () => {
          throw new Error("Host rejected the review command");
        })}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reject" })).toBeVisible(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Host rejected the review command",
    );
  });

  it("resets region action state when the project epoch changes with the same edit id", async () => {
    let finishReview!: (result: { queued: boolean }) => void;
    const onReviewAction = vi.fn(
      () =>
        new Promise<{ queued: boolean }>((resolve) => {
          finishReview = resolve;
        }),
    );
    selectPending();
    const props = {
      edits: [edit],
      trackId: "host",
      zoomPxPerSec: 10,
      timelineWidthPx: 1000,
      selectedId: "cut_1",
      projectPath: "/tmp/p.json",
      clipsByTrack: {},
      canAdjust: true,
      canApply: true,
      onSelect: vi.fn(),
      onCommitSpan: vi.fn(),
      onReviewAction,
    } as const;
    const view = render(<PendingEditOverlayView {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();

    useDawStore
      .getState()
      .hydrate("/tmp/copied.json", minimalProject({ pending_edits: [edit] }));
    useDawStore.getState().setSelection({
      kind: "pending",
      id: edit.id,
      trackId: edit.track_id,
    });
    view.rerender(
      <PendingEditOverlayView {...props} projectPath="/tmp/copied.json" />,
    );

    const freshApprove = await screen.findByRole("button", { name: "Approve" });
    expect(freshApprove).toBeEnabled();
    await act(async () => {
      finishReview({ queued: false });
    });
    await waitFor(() => expect(freshApprove).toBeEnabled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("routes the transcript-refine error to the host waiver recovery", async () => {
    selectPending();
    const onReviewAction = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(
          "technical gate detail",
          TRANSCRIPT_REFINE_REQUIRED_CODE,
          409,
        ),
      )
      .mockResolvedValue({ queued: false });
    render(
      <PendingEditOverlayView
        edits={[edit]}
        trackId="host"
        zoomPxPerSec={10}
        timelineWidthPx={1000}
        selectedId="cut_1"
        projectPath="/tmp/p.json"
        clipsByTrack={{}}
        canAdjust
        canApply
        onSelect={vi.fn()}
        onCommitSpan={vi.fn()}
        onReviewAction={onReviewAction}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve" })).toBeVisible(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Transcript refinement is required before approval.",
    );
    expect(
      await screen.findByRole("region", { name: "Transcript refine recovery" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Waiver reason")).toBeInTheDocument();
    await userEvent.type(
      screen.getByLabelText("Waiver reason"),
      "Reviewed transcript audio",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Waive with reason" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Waiver recorded. Retry approval to apply pending edits.",
    );
    expect(waiveTranscriptRefine).toHaveBeenCalledWith(
      "/tmp/p.json",
      "Reviewed transcript audio",
    );
    expect(onReviewAction).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onReviewAction).toHaveBeenCalledTimes(2));
  });
});
