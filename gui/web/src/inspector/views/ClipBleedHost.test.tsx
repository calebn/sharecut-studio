import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { undoHistory } from "../../api";
import {
  type ClipBleedInspection,
  loadClipBleedInspection,
  type OpaqueBleedRestoreTarget,
  restoreClipBleed,
} from "../../api/clipBleed";
import { registerClipBleedCommands } from "../../commands/clipBleed";
import { clearRegisteredCommands } from "../../commands/execute";
import {
  _resetHistoryMovesForTests,
  registerHistoryCommands,
} from "../../commands/history";
import { _resetTrackMutateChainForTests } from "../../commands/trackMutation";
import { resetDocumentAuthority } from "../../document/authorityState";
import { bleedAttenuationRegionKey } from "../../edit/bleedAttenuation";
import { clipBleedSession } from "../../edit/clipBleedSession";
import { cancelClipPlacement } from "../../edit/clipPlacement";
import { useDawStore } from "../../state/dawStore";
import { deferred } from "../../test/deferred";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import {
  type ClipRow,
  HISTORY_ROOT_ID,
  parseHistoryEntryId,
} from "../../types/project";
import { ApiError } from "../../utils/apiError";
import { ClipBleedHost } from "./ClipBleedHost";

vi.mock("../../api/clipBleed", () => ({
  loadClipBleedInspection: vi.fn(),
  restoreClipBleed: vi.fn(),
}));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  undoHistory: vi.fn(),
}));
vi.mock("../../commands/trackMix", () => ({
  flushPendingMix: vi.fn(async () => {}),
}));

const path = "/tmp/bleed/episode.sharecut";
const head = parseHistoryEntryId("restore-head")!;
const occurrence = { trackId: "host", clipId: "clip-1", clipLabel: "Host" };
const otherOccurrence = {
  ...occurrence,
  clipId: "clip-2",
  clipLabel: "Other copy",
};
const clip: ClipRow = {
  id: occurrence.clipId,
  track_id: occurrence.trackId,
  source_start: 0,
  source_end: 10,
  timeline_start: 0,
  timeline_end: 10,
  source_id: "recording-1",
  source_duration_sec: 10,
  recording_key: "recording-1",
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
};
const target = Object.freeze({
  opaque: "server-issued-target",
}) as unknown as OpaqueBleedRestoreTarget;

function inspection(request = occurrence): ClipBleedInspection {
  return {
    clipLabel: request.clipLabel,
    planState: "ready",
    planReasons: [],
    artifactState: "stale",
    restoreState: "none",
    savedSourceSpans: [],
    fadeSec: 0.005,
    reduction: "attenuate",
    attenuationDb: -24,
    regions: [
      {
        trackId: request.trackId,
        occurrenceId: request.clipId,
        kind: "late_gate",
        sourceSpan: { start: 2, end: 4 },
        timelineSpan: { start: 2, end: 4 },
        actualSourceSpan: { start: 2, end: 4 },
        restore: {
          state: "available",
          target,
          sourceSpan: { start: 2, end: 4 },
        },
      },
    ],
  };
}
const regionKey = bleedAttenuationRegionKey(inspection().regions[0]);
function select(request = occurrence, key: string | null = null) {
  useDawStore.getState().setSelection({
    kind: "bleedAttenuation",
    id: request.clipId,
    trackId: request.trackId,
    regionKey: key,
  });
}
function setHead(next = head) {
  const project = useDawStore.getState().project!;
  useDawStore.setState({
    project: { ...project, history: { ...project.history, head_id: next } },
  });
}
async function ready() {
  return screen.findByRole("button", {
    name: /^Automatic reduction Timeline /,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clipBleedSession.retire();
  cancelClipPlacement();
  _resetTrackMutateChainForTests();
  _resetHistoryMovesForTests();
  clearRegisteredCommands();
  registerClipBleedCommands();
  registerHistoryCommands();
  resetDocumentAuthority(path);
  useDawStore.setState({
    projectPath: path,
    projectEpoch: 7,
    project: minimalProject({
      project_path: path,
      tracks: [sampleTrack()],
      clips: {
        tracks: {
          host: [
            clip,
            {
              ...clip,
              id: otherOccurrence.clipId,
              timeline_start: 20,
              timeline_end: 30,
            },
          ],
        },
        clip_count: 2,
      },
    }),
    guestMode: null,
    heldTrim: null,
    joinMutationInFlight: false,
    timelineDragging: false,
    rangeBusy: false,
    selection: null,
    feedbackToast: null,
  });
  select();
  vi.mocked(loadClipBleedInspection).mockImplementation(async (request) =>
    inspection(request),
  );
  vi.mocked(restoreClipBleed).mockImplementation(async () => {
    setHead();
    return { status: "acknowledged", historyHead: head };
  });
  vi.mocked(undoHistory).mockImplementation(async () => {
    setHead(HISTORY_ROOT_ID);
    return HISTORY_ROOT_ID;
  });
});
afterEach(() => {
  vi.useRealTimers();
  clipBleedSession.retire();
  resetDocumentAuthority();
});

describe("ClipBleedHost", () => {
  it("opens the occurrence, saves the selected region and retains its exact Undo without refreshing", async () => {
    render(<ClipBleedHost {...occurrence} />);
    const region = await ready();
    expect(loadClipBleedInspection).toHaveBeenCalledExactlyOnceWith(
      { ...occurrence, projectPath: path },
      expect.any(AbortSignal),
    );
    const restore = screen.getByRole("button", {
      name: "Restore original audio",
    });
    expect(restore).toBeDisabled();
    await userEvent.click(region);
    expect(useDawStore.getState().selection).toEqual({
      kind: "bleedAttenuation",
      id: occurrence.clipId,
      trackId: occurrence.trackId,
      regionKey,
    });
    await userEvent.click(restore);
    const undo = await screen.findByRole("button", { name: "Undo Restore" });
    expect(restoreClipBleed).toHaveBeenCalledExactlyOnceWith(path, target);
    expect(loadClipBleedInspection).toHaveBeenCalledTimes(1);
    expect(clipBleedSession.getSnapshot()?.undo?.expectedHeadId).toBe(head);
    await userEvent.click(undo);
    await waitFor(() => expect(undoHistory).toHaveBeenCalledTimes(1));
    expect(vi.mocked(undoHistory).mock.calls[0][1]?.expectedHeadId).toBe(head);
    expect(
      screen.queryByRole("button", { name: "Undo Restore" }),
    ).not.toBeInTheDocument();
  });

  it("adopts the overlay's local region selection and clears it when the local selection clears", async () => {
    select(occurrence, regionKey);
    render(<ClipBleedHost {...occurrence} />);
    const region = await ready();
    await waitFor(() => expect(region).toHaveAttribute("aria-pressed", "true"));
    expect(
      screen.getByRole("button", { name: "Restore original audio" }),
    ).toBeEnabled();
    act(() => select(occurrence, null));
    await waitFor(() =>
      expect(region).toHaveAttribute("aria-pressed", "false"),
    );
    expect(clipBleedSession.currentTarget()).toBeNull();
  });

  it("shows loading and inspection failures with a working explicit refresh", async () => {
    const read = deferred<ClipBleedInspection>();
    vi.mocked(loadClipBleedInspection).mockReturnValueOnce(read.promise);
    render(<ClipBleedHost {...occurrence} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking automatic regions…",
    );
    await act(async () =>
      read.reject(new Error("Could not inspect. Refresh regions.")),
    );
    expect(
      screen.getByText("Could not inspect. Refresh regions."),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh regions" }),
    );
    await ready();
    expect(loadClipBleedInspection).toHaveBeenCalledTimes(2);
  });

  it("clears a selected region on direct refresh and requires a new selection", async () => {
    render(<ClipBleedHost {...occurrence} />);
    await userEvent.click(await ready());
    const restore = screen.getByRole("button", {
      name: "Restore original audio",
    });
    expect(restore).toBeEnabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh regions" }),
    );
    const region = await ready();
    expect(loadClipBleedInspection).toHaveBeenCalledTimes(2);
    expect(region).toHaveAttribute("aria-pressed", "false");
    expect(restore).toBeDisabled();
    await userEvent.click(region);
    expect(restore).toBeEnabled();
  });

  it("keeps a saving action visible, disables duplicate presses and leaves Refresh explicit", async () => {
    const reply = deferred<Awaited<ReturnType<typeof restoreClipBleed>>>();
    vi.mocked(restoreClipBleed).mockReturnValueOnce(reply.promise);
    render(<ClipBleedHost {...occurrence} />);
    await userEvent.click(await ready());
    const restore = screen.getByRole("button", {
      name: "Restore original audio",
    });
    vi.useFakeTimers();
    await act(async () => restore.click());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saving Restore choice…",
    );
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.getByRole("status")).toHaveTextContent("2 s elapsed.");
    vi.useRealTimers();
    act(() => select(occurrence, null));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saving Restore choice…",
    );
    expect(restore).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Refresh regions" }),
    ).toBeDisabled();
    await userEvent.click(restore);
    expect(restoreClipBleed).toHaveBeenCalledTimes(1);
    await act(async () => {
      setHead();
      reply.resolve({ status: "acknowledged", historyHead: head });
      await reply.promise;
    });
    expect(screen.getByRole("button", { name: "Undo Restore" })).toBeEnabled();
    expect(loadClipBleedInspection).toHaveBeenCalledTimes(1);
  });

  it("retires stale server targets and requires refresh and a new selection", async () => {
    vi.mocked(restoreClipBleed).mockRejectedValueOnce(
      new ApiError("Changed", "bleed_restore_changed", 409),
    );
    render(<ClipBleedHost {...occurrence} />);
    await userEvent.click(await ready());
    await userEvent.click(
      screen.getByRole("button", { name: "Restore original audio" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This region changed. Refresh regions and select it again.",
    );
    expect(useDawStore.getState().selection).toMatchObject({ regionKey: null });
    expect(
      screen.getByRole("button", { name: "Restore original audio" }),
    ).toBeDisabled();
    expect(loadClipBleedInspection).toHaveBeenCalledTimes(1);
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh regions" }),
    );
    const region = await ready();
    expect(region).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "Restore original audio" }),
    ).toBeDisabled();
  });

  it("retires the old occurrence and ignores its late inspection", async () => {
    const first = deferred<ClipBleedInspection>();
    vi.mocked(loadClipBleedInspection).mockReturnValueOnce(first.promise);
    const view = render(<ClipBleedHost {...occurrence} />);
    const signal = vi.mocked(loadClipBleedInspection).mock.calls[0][1];
    act(() => select(otherOccurrence));
    view.rerender(<ClipBleedHost {...otherOccurrence} />);
    await ready();
    expect(signal.aborted).toBe(true);
    expect(screen.getByText("Other copy")).toBeVisible();
    await act(async () => first.resolve(inspection()));
    expect(clipBleedSession.getSnapshot()?.occurrence.clipId).toBe(
      otherOccurrence.clipId,
    );
    expect(screen.queryByText("Host")).not.toBeInTheDocument();
  });

  it("starts a fresh inspection after an opening change and does not retain old Undo", async () => {
    const view = render(<ClipBleedHost {...occurrence} />);
    await userEvent.click(await ready());
    await userEvent.click(
      screen.getByRole("button", { name: "Restore original audio" }),
    );
    expect(
      await screen.findByRole("button", { name: "Undo Restore" }),
    ).toBeVisible();
    act(() => {
      resetDocumentAuthority(path);
      useDawStore.setState({ projectEpoch: 8 });
    });
    view.rerender(<ClipBleedHost {...occurrence} />);
    await ready();
    expect(
      screen.queryByRole("button", { name: "Undo Restore" }),
    ).not.toBeInTheDocument();
    expect(loadClipBleedInspection).toHaveBeenCalledTimes(2);
  });

  it.each([
    { projectPath: "share:review-token", guestMode: "edit" },
    { projectPath: path, guestMode: "view" },
  ])(
    "does not inspect or expose restore controls to a guest at $projectPath",
    ({ projectPath, guestMode }) => {
      useDawStore.setState({ projectPath, guestMode });
      render(<ClipBleedHost {...occurrence} />);
      expect(
        screen.getByRole("heading", { name: "Automatic reduction" }),
      ).toBeVisible();
      expect(loadClipBleedInspection).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("button", { name: "Restore original audio" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Refresh regions" }),
      ).not.toBeInTheDocument();
    },
  );

  it("aborts inspection and retires its session when unmounted", async () => {
    const read = deferred<ClipBleedInspection>();
    vi.mocked(loadClipBleedInspection).mockReturnValueOnce(read.promise);
    const view = render(<ClipBleedHost {...occurrence} />);
    const signal = vi.mocked(loadClipBleedInspection).mock.calls[0][1];
    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(clipBleedSession.getSnapshot()).toBeNull();
    await act(async () => read.resolve(inspection()));
    expect(clipBleedSession.getSnapshot()).toBeNull();
  });
});
