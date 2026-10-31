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
import { expectNoA11yViolations } from "../../test/a11y";
import { deferred } from "../../test/deferred";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import {
  type ClipRow,
  HISTORY_ROOT_ID,
  parseHistoryEntryId,
} from "../../types/project";
import { ApiError } from "../../utils/apiError";
import { SectionsBody } from "./SectionsBody";

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
const occurrence = { trackId: "host", clipId: "clip-1", clipLabel: "host" };
const otherOccurrence = {
  ...occurrence,
  clipId: "clip-2",
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

describe("automatic reduction sheet content", () => {
  it("opens the occurrence, saves the selected region and retains its exact Undo without refreshing", async () => {
    render(<SectionsBody withRange={false} />);
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
    render(<SectionsBody withRange={false} />);
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
    render(<SectionsBody withRange={false} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking automatic regions…",
    );
    expect(
      screen.getByRole("button", { name: "Refresh regions" }),
    ).toBeDisabled();
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
    render(<SectionsBody withRange={false} />);
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
    render(<SectionsBody withRange={false} />);
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
    expect(
      screen
        .getAllByRole("button")
        .filter((button) => button.closest(".sys-inspector-rows"))
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
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
    render(<SectionsBody withRange={false} />);
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
    const view = render(<SectionsBody withRange={false} />);
    const signal = vi.mocked(loadClipBleedInspection).mock.calls[0][1];
    act(() => select(otherOccurrence));
    view.rerender(<SectionsBody withRange={false} />);
    await ready();
    expect(signal.aborted).toBe(true);
    await act(async () => first.resolve(inspection()));
    expect(clipBleedSession.getSnapshot()?.occurrence.clipId).toBe(
      otherOccurrence.clipId,
    );
  });

  it("starts a fresh inspection after an opening change and does not retain old Undo", async () => {
    const view = render(<SectionsBody withRange={false} />);
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
    view.rerender(<SectionsBody withRange={false} />);
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
      render(<SectionsBody withRange={false} />);
      expect(
        screen.getByText("Only the project host can inspect this audio."),
      ).toBeVisible();
      expect(
        screen.getByText("Only the project host can restore this audio."),
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
    const view = render(<SectionsBody withRange={false} />);
    const signal = vi.mocked(loadClipBleedInspection).mock.calls[0][1];
    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(clipBleedSession.getSnapshot()).toBeNull();
    await act(async () => read.resolve(inspection()));
    expect(clipBleedSession.getSnapshot()).toBeNull();
  });

  it("shows no Undo Restore to a guest even when a session holds an undo receipt", async () => {
    render(<SectionsBody withRange={false} />);
    await userEvent.click(await ready());
    await userEvent.click(
      screen.getByRole("button", { name: "Restore original audio" }),
    );
    expect(
      await screen.findByRole("button", { name: "Undo Restore" }),
    ).toBeVisible();
    expect(clipBleedSession.getSnapshot()?.undo).not.toBeNull();
    act(() => {
      useDawStore.setState({ guestMode: "view" });
    });
    expect(
      screen.queryByRole("button", { name: "Undo Restore" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Restore original audio" }),
    ).not.toBeInTheDocument();
  });

  describe("gates and copy", () => {
    const second = {
      ...inspection().regions[0],
      kind: "bleed_mute:off_speaker" as const,
      timelineSpan: { start: 5, end: 6 },
      restore: {
        state: "available" as const,
        target: Object.freeze({
          opaque: "second",
        }) as unknown as OpaqueBleedRestoreTarget,
        sourceSpan: { start: 5, end: 6 },
      },
    };
    const load = (patch: Partial<ClipBleedInspection>) =>
      vi
        .mocked(loadClipBleedInspection)
        .mockImplementation(async (request) => ({
          ...inspection(request),
          ...patch,
        }));
    const restoreButton = () =>
      screen.getByRole("button", { name: "Restore original audio" });

    it("submits only the selected region's target, with Enter and Space on a region", async () => {
      load({
        regions: [...inspection().regions, second],
        planState: "disabled",
        planReasons: ["Check the recording and refresh regions."],
      });
      render(<SectionsBody withRange={false} />);
      await ready();
      expect(
        screen.getByText("Check the recording and refresh regions."),
      ).toBeVisible();
      expect(restoreButton()).toBeDisabled();
      const mute = screen.getByRole("button", {
        name: /^Automatic speaker mute Timeline /,
      });
      mute.focus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(mute).toHaveAttribute("aria-pressed", "true"));
      await userEvent.keyboard(" ");
      expect(mute).toHaveAttribute("aria-pressed", "true");
      expect(restoreClipBleed).not.toHaveBeenCalled();
      await userEvent.click(restoreButton());
      expect(restoreClipBleed).toHaveBeenCalledExactlyOnceWith(
        path,
        second.restore.target,
      );
    });

    it("shows the selected and restorable source intervals and submits the selected target by identity", async () => {
      const base = inspection().regions[0];
      load({
        regions: [
          {
            ...base,
            sourceSpan: { start: 20, end: 21 },
            restore: {
              state: "available",
              target,
              sourceSpan: { start: 20.5, end: 21 },
            },
          },
        ],
      });
      render(<SectionsBody withRange={false} />);
      await userEvent.click(await ready());
      expect(screen.getByText("Selected source interval")).toBeVisible();
      expect(screen.getByText("Restore source interval")).toBeVisible();
      expect(screen.getByText("20.500 to 21.000 s")).toBeVisible();
      await userEvent.click(restoreButton());
      expect(restoreClipBleed).toHaveBeenCalledTimes(1);
      expect(vi.mocked(restoreClipBleed).mock.calls[0][1]).toBe(target);
    });

    it("explains the host permission gate and never submits while blocked", async () => {
      render(<SectionsBody withRange={false} />);
      await userEvent.click(await ready());
      useDawStore.setState({ rangeBusy: true });
      await waitFor(() =>
        expect(restoreButton()).toHaveAccessibleDescription(
          "Wait for the range edit to finish.",
        ),
      );
      await userEvent.click(restoreButton());
      expect(restoreClipBleed).not.toHaveBeenCalled();
    });

    it("shows saved coverage and render pending until the artifact is current", async () => {
      load({
        restoreState: "current",
        savedSourceSpans: [{ start: 20, end: 20.5 }],
      });
      const view = render(<SectionsBody withRange={false} />);
      await ready();
      expect(
        screen.getByText("Restore choice saved for this recording."),
      ).toBeVisible();
      expect(screen.getByText("20.000 to 20.500 s")).toBeVisible();
      expect(
        screen.getByText(/Saved choices are pending in the next render/),
      ).toBeVisible();
      load({
        restoreState: "current",
        savedSourceSpans: [{ start: 20, end: 20.5 }],
        artifactState: "current",
      });
      await userEvent.click(
        screen.getByRole("button", { name: "Refresh regions" }),
      );
      await screen.findByText("Rendered audio is current.");
      expect(
        screen.queryByText(/Saved choices are pending/),
      ).not.toBeInTheDocument();
      view.unmount();
    });

    it.each(["changed_content", "unverified"] as const)(
      "keeps %s saved choices distinct from current rendered audio",
      async (restoreState) => {
        load({ restoreState, artifactState: "current" });
        render(<SectionsBody withRange={false} />);
        await ready();
        expect(screen.getByText("Rendered audio is current.")).toBeVisible();
        expect(screen.getByText(/Refresh regions to/)).toBeVisible();
      },
    );

    it.each(["disabled", "unavailable_evidence"] as const)(
      "keeps authored mutes actionable when the late plan is %s",
      async (planState) => {
        load({
          regions: [...inspection().regions, second],
          planState,
          planReasons: ["Check the recording and refresh regions."],
        });
        render(<SectionsBody withRange={false} />);
        await ready();
        expect(
          screen.getByText("Check the recording and refresh regions."),
        ).toBeVisible();
        await userEvent.click(
          screen.getByRole("button", {
            name: /^Automatic speaker mute Timeline /,
          }),
        );
        await userEvent.click(restoreButton());
        expect(vi.mocked(restoreClipBleed).mock.calls[0][1]).toBe(
          second.restore.target,
        );
      },
    );

    it("says so when the plan has no regions, and why saved or unavailable intervals cannot be restored", async () => {
      load({ regions: [], artifactState: "missing" });
      const view = render(<SectionsBody withRange={false} />);
      await screen.findByText(/No automatic regions in this clip/);
      expect(screen.getByText(/No rendered audio yet/)).toBeVisible();
      view.unmount();
      load({
        regions: [{ ...inspection().regions[0], restore: { state: "saved" } }],
      });
      const saved = render(<SectionsBody withRange={false} />);
      await userEvent.click(await ready());
      expect(restoreButton()).toHaveAccessibleDescription(
        "A Restore choice already covers this interval.",
      );
      saved.unmount();
      load({
        regions: [
          {
            ...inspection().regions[0],
            restore: {
              state: "unavailable",
              reason:
                "The recording is missing. Restore it and refresh regions.",
            },
          },
        ],
      });
      render(<SectionsBody withRange={false} />);
      await userEvent.click(await ready());
      expect(restoreButton()).toHaveAccessibleDescription(
        "The recording is missing. Restore it and refresh regions.",
      );
    });

    it("mounts no empty rows when there is nothing to report", async () => {
      const { container } = render(<SectionsBody withRange={false} />);
      await ready();
      const rows = [...container.querySelectorAll(".sys-inspector-row")];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.textContent !== "")).toBe(true);
    });

    it("has no accessibility violations", async () => {
      const { container } = render(<SectionsBody withRange={false} />);
      await ready();
      await expectNoA11yViolations(container);
    });
  });
});
