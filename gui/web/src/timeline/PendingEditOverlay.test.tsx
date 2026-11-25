import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updatePendingEdit } from "../api";
import { clearRegisteredCommands } from "../commands/execute";
import {
  _resetHistoryMovesForTests,
  registerHistoryCommands,
} from "../commands/history";
import { executePointerCommand } from "../commands/pointer";
import { registerDawCommands } from "../commands/register";
import { applyDocumentResult } from "../document/applyDocumentUpdate";
import {
  activateDocumentScope,
  resetDocumentAuthority,
} from "../document/authorityState";
import { FeedbackToast } from "../feedback/FeedbackToast";
import { useWaveformSnapTicks } from "../hooks/useWaveformSnapTicks";
import { QUEUED_NOTICE_POLL_MS } from "../inspector/useQueuedReviewNotice";
import {
  submitLiveHistoryCommand,
  submitQueuedDocumentCommand,
} from "../services/commandQueue";
import * as offlineStore from "../services/offlineQueue/offlineStore";
import { shareProjectKey } from "../shareMode";
import { PendingEditBody } from "../stage/edit/PendingEditBody";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import {
  COMMENTER_CAPABILITIES,
  clipRow,
  minimalProject,
} from "../test/fixtures";
import { decide } from "../test/pendingDecision";
import type { PendingEditView } from "../types/project";
import { PENDING_REVIEW_QUEUED_MESSAGE } from "../utils/pendingEditLabels";
import { PendingEditOverlay } from "./PendingEditOverlay";
import { PendingEditOverlayView } from "./PendingEditOverlayView";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  updatePendingEdit: vi.fn(async () => undefined),
}));
vi.mock("../hooks/useWaveformSnapTicks", () => ({
  useWaveformSnapTicks: vi.fn(() => ({
    ticks: [],
    resolveTicks: vi.fn(async () => []),
  })),
}));

vi.mock("../services/commandQueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/commandQueue")>()),
  submitQueuedDocumentCommand: vi.fn(),
  submitLiveHistoryCommand: vi.fn(),
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
  kind: "other",
  harsh: false,
  applied: false,
  suggest_reason: null,
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
    vi.mocked(useWaveformSnapTicks).mockReturnValue(snapResource([]));
    HTMLElement.prototype.setPointerCapture = vi.fn();
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ pending_edits: [edit] }));
    useDawStore.setState({
      stage: "review",
      statusAnnouncement: "",
      feedbackToast: null,
      pendingRetimeInFlight: null,
    });
  });

  it.each([
    ["/tmp/p.json", null, null],
    [shareProjectKey("tok"), "edit", ["view", "edit"]],
    [shareProjectKey("tok"), "comment", COMMENTER_CAPABILITIES],
  ] as const)(
    "presents exact islands without source handles at %s in mode %s",
    async (path, guestMode, capabilities) => {
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
        .hydrate(
          path,
          minimalProject({ pending_edits: [exact] }),
          guestMode,
          capabilities ? [...capabilities] : null,
        );
      useDawStore.setState({ stage: "review" });
      useDawStore.setState({
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
        onSelect={vi.fn()}
        onCommitSpan={vi.fn()}
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

  it.each([
    ["Snap on", true, false, 4.3],
    ["Snap off", false, false, 5],
    ["Snap on with Alt", true, true, 5],
    ["Snap off with Alt", false, true, 4.3],
  ])(
    "commits an edge drag with %s at the matching bound",
    async (_name, snapEnabled, altKey, expected) => {
      useDawStore.setState({ snapEnabled });
      vi.mocked(useWaveformSnapTicks).mockReturnValue(snapResource([4.3]));
      const resource = snapResource([4.3]);
      vi.mocked(useWaveformSnapTicks).mockReturnValue(resource);
      const { container } = setup(10);
      const end = container.querySelector(".pending-handle.end") as HTMLElement;
      fireEvent.pointerDown(end, { clientX: 100, pointerId: 3 });
      fireEvent.pointerMove(end, { clientX: 130, pointerId: 3, altKey });
      fireEvent.pointerUp(end, { clientX: 130, pointerId: 3, altKey });
      await waitFor(() =>
        expect(updatePendingEdit).toHaveBeenCalledWith(
          "/tmp/p.json",
          "cut_1",
          0,
          expected,
          false,
        ),
      );
      expect(resource.resolveTicks).toHaveBeenCalledTimes(
        snapEnabled !== altKey ? 1 : 0,
      );
      useDawStore.setState({ snapEnabled: true });
    },
  );

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
        onSelect={vi.fn()}
        onCommitSpan={() => {
          expect(
            (container.querySelector(".pending-overlay") as HTMLElement).style
              .width,
          ).toBe("43px");
          onCommitSpan();
        }}
      />,
    );
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 21 });
    fireEvent.pointerMove(end, { clientX: 130, pointerId: 21 });
    fireEvent.pointerUp(end, { clientX: 130, pointerId: 21 });
    expect(useDawStore.getState().pendingRetimeInFlight).toBe("cut_1");
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
        onSelect={vi.fn()}
        onCommitSpan={onCommitSpan}
      />,
    );
    const end = container.querySelector(".pending-handle.end") as HTMLElement;
    fireEvent.pointerDown(end, { clientX: 100, pointerId: 22 });
    fireEvent.pointerMove(end, { clientX: 130, pointerId: 22 });
    fireEvent.pointerUp(end, { clientX: 130, pointerId: 22 });
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Nearby waveform snap points could not be loaded. Try again.",
      ),
    );
    expect(useDawStore.getState().feedbackToast?.tone).toBe("error");
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
        onSelect={vi.fn()}
        onCommitSpan={onCommitSpan}
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
      onSelect: vi.fn(),
      onCommitSpan,
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
        onSelect={vi.fn()}
        onCommitSpan={onCommitSpan}
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
    useDawStore.setState({ stage: "review" });
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
    useDawStore.setState({
      stage: "review",
      statusAnnouncement: "",
      feedbackToast: null,
      pendingRetimeInFlight: null,
    });
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
        onSelect={onSelect}
        onCommitSpan={onCommitSpan}
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
        onSelect={onSelect}
        onCommitSpan={onCommitSpan}
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
        onSelect={onSelect}
        onCommitSpan={onCommitSpan}
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
    expect(useDawStore.getState().pendingRetimeInFlight).toBe("cut_1");

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
    await act(async () => {
      resolveTicks([]);
    });
    await waitFor(() =>
      expect(useDawStore.getState().pendingRetimeInFlight).toBeNull(),
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
          onSelect={onSelect}
          onCommitSpan={onCommitSpan}
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
        onSelect={vi.fn()}
        onCommitSpan={vi.fn()}
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

  it("floats the label of a selected narrow edit on its own lane without hover or focus", async () => {
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
        onSelect={vi.fn()}
        onCommitSpan={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        document.body.querySelector(".pending-label--floating"),
      ).not.toBeNull(),
    );
  });

  it("re-measures the floating label's clamp when the Inspector column opens", async () => {
    const column = document.createElement("div");
    column.className = "bottom-sheet--column";
    document.body.append(column);
    let columnLeft = 5000;
    const rect = (left: number) => ({
      x: left,
      y: 40,
      left,
      top: 40,
      right: left + 20,
      bottom: 60,
      width: 20,
      height: 20,
      toJSON: () => ({}),
    });
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return this === column ? rect(columnLeft) : rect(900);
      });
    try {
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
          onSelect={vi.fn()}
          onCommitSpan={vi.fn()}
        />,
      );
      const floating = () =>
        document.body.querySelector<HTMLElement>(".pending-label--floating");
      await waitFor(() => expect(floating()).not.toBeNull());
      const before = Number.parseFloat(floating()!.style.left);
      columnLeft = 400;
      act(() => useDawStore.setState({ inspectorKey: "pending:cut_1" }));
      await waitFor(() =>
        expect(Number.parseFloat(floating()!.style.left)).toBeLessThan(before),
      );
    } finally {
      spy.mockRestore();
      column.remove();
    }
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
        onSelect={vi.fn()}
        onCommitSpan={vi.fn()}
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
        onSelect={onSelect}
        onCommitSpan={onCommitSpan}
      />,
    );
    expect(container.querySelector(".pending-handle")).toBeNull();
  });
});

describe("single pending review feedback", () => {
  const path = "/tmp/p.json";
  const head = "1b0040fb2927";
  const pending = () => minimalProject({ pending_edits: [edit] });

  beforeEach(() => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        callback: IntersectionObserverCallback;
        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback;
        }
        observe(target: Element) {
          this.callback(
            [
              {
                isIntersecting: true,
                intersectionRatio: 1,
                target,
              } as IntersectionObserverEntry,
            ],
            this as unknown as IntersectionObserver,
          );
        }
        disconnect() {}
      },
    );
    clearRegisteredCommands();
    registerHistoryCommands();
    _resetHistoryMovesForTests();
    resetDocumentAuthority();
    useDawStore.getState().hydrate(path, pending());
    useDawStore.setState({ stage: "review" });
    activateDocumentScope(path);
    useDawStore.setState({
      selection: { kind: "pending", id: edit.id, trackId: "host" },
      feedbackToast: null,
      statusAnnouncement: "",
    });
    vi.mocked(submitQueuedDocumentCommand).mockReset();
    vi.mocked(submitLiveHistoryCommand)
      .mockReset()
      .mockImplementation(async () => {
        useDawStore.setState({ project: pending() });
        return { history_head_id: "root" };
      });
  });

  async function review(label: "Approve" | "Reject") {
    await decide(label === "Approve" ? "cut" : "keep");
  }

  async function reviewToast(message: string) {
    await waitFor(
      () => expect(useDawStore.getState().feedbackToast?.message).toBe(message),
      { timeout: 10_000 },
    );
    return screen.findByText(message, undefined, { timeout: 10_000 });
  }

  function mountReview() {
    useDawStore
      .getState()
      .setSelection({ kind: "pending", id: edit.id, trackId: "host" });
    render(
      <>
        <PendingEditBody edit={edit} />
        <FeedbackToast />
      </>,
    );
  }

  function reviewReply(count: number, historyHead: string | null) {
    return {
      history_head_id: historyHead,
      review_result: { count },
      snapshot: {
        server_seq: 1,
        project: minimalProject({ pending_edits: [] }),
      },
    };
  }

  function queuedReviewOutbox() {
    const commands: offlineStore.QueuedCommand[] = [];
    const queue = vi
      .spyOn(offlineStore, "loadHostCommandQueue")
      .mockImplementation(async () => commands);
    const count = vi
      .spyOn(offlineStore, "loadHostCommandCount")
      .mockImplementation(async () => commands.length);
    vi.mocked(submitQueuedDocumentCommand).mockImplementation(
      async (_path, type, payload = {}) => {
        commands.push({
          command_id: "queued-review",
          client_id: "fixture-client",
          client_seq: 1,
          created_at: 0,
          type,
          payload,
        });
        return { queued: true, history_head_id: head };
      },
    );
    return {
      commands,
      restore() {
        queue.mockRestore();
        count.mockRestore();
      },
    };
  }

  describe("the Inspector", () => {
    it.each([
      ["Approve", "ApproveEdits", "Approved 1 pending edit"],
      ["Reject", "RejectEdits", "Rejected 1 pending edit"],
    ] as const)(
      "%s clears selection before document adoption and Undo restores the edit",
      async (label, command, message) => {
        const user = userEvent.setup();
        const reply = reviewReply(1, head);
        vi.mocked(submitQueuedDocumentCommand).mockResolvedValue(reply);
        mountReview();
        await review(label);
        expect(await reviewToast(message)).toBeVisible();
        expect(useDawStore.getState().feedbackToast?.undo).toBe(head);
        expect(submitQueuedDocumentCommand).toHaveBeenCalledWith(
          path,
          command,
          { ids: [edit.id] },
          command === "ApproveEdits"
            ? { refineRecoveryInline: true }
            : undefined,
        );
        expect(useDawStore.getState().project?.pending_edits).toEqual([edit]);
        expect(useDawStore.getState().selection).toBeNull();
        act(() => {
          applyDocumentResult(reply, activateDocumentScope(path));
        });
        expect(useDawStore.getState().project?.pending_edits).toEqual([]);
        expect(useDawStore.getState().selection).toBeNull();
        await user.click(screen.getByRole("button", { name: "Undo" }));
        await waitFor(() =>
          expect(useDawStore.getState().project?.pending_edits).toEqual([edit]),
        );
        expect(submitLiveHistoryCommand).toHaveBeenCalledWith(
          path,
          "UndoHistory",
          { rerender: false, expected_head_id: head },
          activateDocumentScope(path),
        );
      },
      20_000,
    );

    it.each([
      ["Approve", null, "No pending edits were approved"],
      ["Reject", head, "No pending edits were rejected"],
    ] as const)(
      "%s reports zero affected edits without Undo",
      async (label, replyHead, message) => {
        vi.mocked(submitQueuedDocumentCommand).mockImplementation(async () => {
          const reply = reviewReply(0, replyHead);
          applyDocumentResult(reply, activateDocumentScope(path));
          return reply;
        });
        mountReview();
        await review(label);
        expect(await reviewToast(message)).toBeVisible();
        expect(useDawStore.getState().feedbackToast?.undo).toBeNull();
        expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
        expect(useDawStore.getState().project?.pending_edits).toEqual([]);
        expect(useDawStore.getState().selection).toBeNull();
      },
      20_000,
    );

    it.each(["Approve", "Reject"] as const)(
      "%s stays queued without completion or Undo",
      async (label) => {
        const outbox = queuedReviewOutbox();
        try {
          mountReview();
          await review(label);
          await waitFor(() => expect(outbox.commands).toHaveLength(1), {
            timeout: 10_000,
          });
          await waitFor(
            () =>
              expect(screen.getByRole("status")).toHaveTextContent(
                "Still sending.",
              ),
            { timeout: 10_000 },
          );
          expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
          expect(useDawStore.getState().feedbackToast?.message).toBe(
            PENDING_REVIEW_QUEUED_MESSAGE,
          );
          expect(useDawStore.getState().project?.pending_edits).toEqual([edit]);
        } finally {
          cleanup();
          outbox.restore();
        }
      },
      20_000,
    );
  });
  it.each(["Approve", "Reject"] as const)(
    "%s keeps its queued notice through polling until the outbox drains",
    async (label) => {
      const outbox = queuedReviewOutbox();
      vi.useFakeTimers();
      try {
        mountReview();
        await act(async () => {});
        expect(screen.queryByText("Checking queued timing…")).toBeNull();
        expect(outbox.commands).toEqual([]);
        registerDawCommands();
        await act(async () => {
          expect(
            await executePointerCommand(
              label === "Approve" ? "edit.delete" : "edit.keep",
            ),
          ).toEqual({ status: "ok" });
        });
        expect(submitQueuedDocumentCommand).toHaveBeenCalledTimes(1);
        expect(outbox.commands).toHaveLength(1);
        expect(outbox.commands[0]?.type).toBe(
          label === "Approve" ? "ApproveEdits" : "RejectEdits",
        );
        expect(outbox.commands[0]?.payload.ids).toEqual([edit.id]);
        expect(screen.getByRole("status")).toHaveTextContent("Still sending.");
        await act(() => vi.advanceTimersByTimeAsync(QUEUED_NOTICE_POLL_MS));
        expect(screen.getByRole("status")).toHaveTextContent("Still sending.");
        expect(useDawStore.getState().feedbackToast?.message).toBe(
          PENDING_REVIEW_QUEUED_MESSAGE,
        );
        expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
        expect(useDawStore.getState().project?.pending_edits).toEqual([edit]);
        outbox.commands.splice(0);
        await act(() => vi.advanceTimersByTimeAsync(QUEUED_NOTICE_POLL_MS));
        expect(screen.queryByRole("status")).toBeNull();
        expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
        expect(useDawStore.getState().project?.pending_edits).toEqual([edit]);
      } finally {
        cleanup();
        vi.useRealTimers();
        outbox.restore();
      }
    },
  );
});

describe("the pending-edit overlay carries no review bar", () => {
  const path = "/tmp/p.json";
  const overlayProps = (target: PendingEditView) => ({
    edits: [target],
    trackId: "host",
    zoomPxPerSec: 10,
    timelineWidthPx: 1000,
    selectedId: target.id,
    onSelect: vi.fn(),
  });

  beforeEach(() => {
    clearRegisteredCommands();
    resetDocumentAuthority();
    vi.mocked(updatePendingEdit).mockReset();
    useDawStore.setState({ statusAnnouncement: "", feedbackToast: null });
    activateDocumentScope(path);
  });

  function mount(target: PendingEditView, stage: "edit" | "review" = "edit") {
    useDawStore
      .getState()
      .hydrate(path, minimalProject({ pending_edits: [target] }));
    useDawStore.setState({
      stage,
      selection: { kind: "pending", id: target.id, trackId: "host" },
    });
    render(<PendingEditOverlay {...overlayProps(target)} />);
  }

  const exactRange = {
    suggested_action: "cut" as const,
    exact_range: {
      intervals: [{ start: 0, end: 2 }],
      clips: [],
      track_ids: ["host"],
    } as never,
  };
  const shapes = [
    ["a cut suggestion", { suggested_action: "cut" as const }],
    ["a shorten suggestion", { suggested_action: "shorten" as const }],
    ["a lower suggestion", { suggested_action: "lower" as const }],
    ["a split", { type: "split", suggested_action: "cut" as const }],
    ["a suggestion to leave alone", { suggested_action: "leave" as const }],
    ["a suggestion with no action", { suggested_action: null }],
    ["an exact range proposal", exactRange],
  ] as const;

  it.each(
    shapes.flatMap(([name, extra]) =>
      (["edit", "review"] as const).map(
        (stage) => [name, extra, stage] as const,
      ),
    ),
  )("draws no actions for %s on the %s stage", async (_name, extra, stage) => {
    mount({ ...edit, ...extra }, stage);
    await act(async () => {});
    expect(screen.queryByRole("region")).toBeNull();
    for (const name of [
      "Approve",
      "Reject",
      "Cut",
      "Keep",
      "Shorten",
      "Lower",
      "Edit timing",
    ])
      expect(screen.queryByRole("button", { name })).toBeNull();
  });

  describe("an edge drag on a suggestion", () => {
    const cutEdit = { ...edit, suggested_action: "cut" as const };

    function dragEnd(container: HTMLElement) {
      const end = container.querySelector(".pending-handle.end") as HTMLElement;
      fireEvent.pointerDown(end, { clientX: 100, pointerId: 31 });
      fireEvent.pointerMove(end, { clientX: 130, pointerId: 31 });
      fireEvent.pointerUp(end, { clientX: 130, pointerId: 31 });
    }

    beforeEach(() => {
      HTMLElement.prototype.setPointerCapture = vi.fn();
    });

    it("holds Cut and Keep (the retime flag) from release until the retime settles", async () => {
      const ticks = deferred<number[]>();
      vi.mocked(useWaveformSnapTicks).mockReturnValue({
        ticks: [],
        resolveTicks: vi.fn(() => ticks.promise),
      });
      const save = deferred<undefined>();
      vi.mocked(updatePendingEdit).mockReturnValue(save.promise as never);
      mount(cutEdit);
      dragEnd(document.body);
      expect(useDawStore.getState().pendingRetimeInFlight).toBe(cutEdit.id);
      await act(async () => ticks.resolve([]));
      await waitFor(() => expect(updatePendingEdit).toHaveBeenCalledOnce());
      expect(useDawStore.getState().pendingRetimeInFlight).toBe(cutEdit.id);
      await act(async () => save.resolve(undefined));
      await waitFor(() =>
        expect(useDawStore.getState().pendingRetimeInFlight).toBeNull(),
      );
    });

    it("clears the retime flag when the snap lookup fails", async () => {
      vi.mocked(useWaveformSnapTicks).mockReturnValue({
        ticks: [],
        resolveTicks: vi.fn(async () => {
          throw new Error("offline");
        }),
      });
      mount(cutEdit);
      dragEnd(document.body);
      await waitFor(() =>
        expect(useDawStore.getState().pendingRetimeInFlight).toBeNull(),
      );
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Nearby waveform snap points could not be loaded. Try again.",
      );
    });

    it.each([
      ["a cut suggestion", { suggested_action: "cut" as const }],
      ["a suggestion with no action", { suggested_action: null }],
      ["a suggestion to leave alone", { suggested_action: "leave" as const }],
    ] as const)(
      "announces a failed retime of %s in the status line",
      async (_name, extra) => {
        vi.mocked(useWaveformSnapTicks).mockReturnValue(snapResource([]));
        vi.mocked(updatePendingEdit).mockRejectedValue(
          new Error("retime refused"),
        );
        mount({ ...cutEdit, ...extra });
        dragEnd(document.body);
        await waitFor(() =>
          expect(useDawStore.getState().statusAnnouncement).toBe(
            "retime refused",
          ),
        );
        expect(useDawStore.getState().feedbackToast?.tone).toBe("error");
        expect(useDawStore.getState().pendingRetimeInFlight).toBeNull();
      },
    );
  });
});
