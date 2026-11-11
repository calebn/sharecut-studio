import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { ReviewQueue } from "../../review/ReviewQueue";
import { useDawStore } from "../../state/dawStore";
import type { DawState } from "../../state/types";
import { useDaw } from "../../state/useDaw";
import { reviewContent } from "../../storybook/reviewContent";
import {
  minimalProject,
  offlineConflict,
  sampleTrack,
} from "../../test/fixtures";
import { DocumentCommand } from "../../types/documentCommands.generated";
import { conflictRowActions } from "./conflictRowActions";
import { useReviewAttention } from "./useReviewAttention";

const KEY = "share:tok-2298";
const CUT = { start: 724, end: 726 };

const store = vi.hoisted(() => ({
  loadGuestAttention: vi.fn(),
  dismissConflicts: vi.fn(),
  loadHostAttention: vi.fn(),
  dismissHostConflicts: vi.fn(),
}));
vi.mock("../../services/offlineQueue/offlineStore", () => store);

const ranges = vi.hoisted(() => ({ runRangeAction: vi.fn() }));
vi.mock("../../commands/rangeActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/rangeActions")>()),
  runRangeAction: ranges.runRangeAction,
}));

const audition = vi.hoisted(() => ({ playTimelineRange: vi.fn() }));
vi.mock("../../utils/playRange", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/playRange")>()),
  playTimelineRange: audition.playTimelineRange,
}));

const staleCut = (id = "cut-1", over: { start?: number; end?: number } = {}) =>
  offlineConflict({
    code: "range_changed",
    reason: "Selected audio changed. Select the range again.",
    command: {
      command_id: id,
      type: DocumentCommand.EditSelectedRange,
      payload: {
        action: "cut",
        targets: [
          {
            intervals: [
              { start: over.start ?? CUT.start, end: over.end ?? CUT.end },
            ],
            track_ids: ["guest"],
            clips: [],
            media_seals: {},
          },
        ],
      },
    },
  });

const guestProject = () =>
  minimalProject({
    timeline_duration_sec: 900,
    tracks: [
      sampleTrack({
        id: "guest",
        duration_sec: 900,
        has_source_audio: true,
        range_media_seal: "fresh-seal",
      }),
    ],
  });

function Queue() {
  const projectPath = useDaw((s) => s.projectPath);
  return (
    <ReviewQueue
      items={[]}
      content={reviewContent}
      selectedId={null}
      filter="all"
      attention={useReviewAttention(projectPath)}
      onFilter={vi.fn()}
      onSelect={vi.fn()}
    />
  );
}

const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

const click = async (name: RegExp | string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await vi.advanceTimersByTimeAsync(0);
  });
};

let announce: ReturnType<typeof vi.fn<DawState["announceStatus"]>>;
const rowOf = (id: string) => ({ id, title: "", detail: "" });

const dismissedOf = (...conflicts: ReturnType<typeof offlineConflict>[]) => ({
  pending: 0,
  conflicts: conflicts.map((c) => ({ ...c, dismissed: true })),
});

beforeEach(() => {
  vi.useFakeTimers();
  clearRegisteredCommands();
  registerDawCommands();
  for (const mock of [
    ...Object.values(store),
    ranges.runRangeAction,
    audition.playTimelineRange,
  ])
    mock.mockReset();
  store.loadGuestAttention.mockResolvedValue({
    pending: 0,
    conflicts: [staleCut()],
  });
  store.dismissConflicts.mockImplementation(async () =>
    dismissedOf(staleCut()),
  );
  ranges.runRangeAction.mockResolvedValue({ status: "ok" });
  useDawStore.getState().hydrate(KEY, guestProject());
  announce = vi.fn<DawState["announceStatus"]>();
  useDawStore.setState({
    announceStatus: announce,
    shareCapabilities: ["view", "comment"],
    rangeBusy: false,
  });
});

afterEach(() => {
  clearRegisteredCommands();
  vi.useRealTimers();
});

describe("the live guest conflict row", () => {
  it("shows the three buttons for a cut the server called stale", async () => {
    render(<Queue />);
    await settle();
    expect(
      screen.getByText("Your cut at 12:04 overlaps a newer edit"),
    ).toBeInTheDocument();
    for (const name of [/^Hear your cut/, /^Suggest again here/, /^Drop it/])
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
  });

  it("keeps the generic row for a refusal that is not a stale cut", async () => {
    store.loadGuestAttention.mockResolvedValue({
      pending: 0,
      conflicts: [offlineConflict()],
    });
    render(<Queue />);
    await settle();
    expect(screen.queryByRole("button", { name: /^Drop it/ })).toBeNull();
  });

  describe("Hear", () => {
    it("plays the current audio around the span with a 2 s pad", async () => {
      render(<Queue />);
      await settle();
      await click(/^Hear your cut/);
      expect(audition.playTimelineRange).toHaveBeenCalledWith(
        expect.objectContaining({ start: CUT.start, end: CUT.end, padSec: 2 }),
      );
    });

    it("is disabled with its reason when the share cannot play audio", async () => {
      useDawStore.setState({ shareCapabilities: ["comment"] });
      render(<Queue />);
      await settle();
      const hear = screen.getByRole("button", { name: /^Hear your cut/ });
      expect(hear).toBeDisabled();
      expect(hear).toHaveAttribute("title", "This share cannot play audio");
    });

    it("also refuses in the handler, with an announcement", async () => {
      useDawStore.setState({ shareCapabilities: ["comment"] });
      render(<Queue />);
      await settle();
      act(() => conflictRowActions(KEY).onHear(rowOf("cut-1")));
      expect(audition.playTimelineRange).not.toHaveBeenCalled();
      expect(announce).toHaveBeenCalledWith("This share cannot play audio", {
        tone: "error",
      });
    });
  });

  describe("Drop it", () => {
    it("clears only that row once, however often it is clicked, and says so", async () => {
      render(<Queue />);
      await settle();
      const drop = screen.getByRole("button", { name: /^Drop it/ });
      await act(async () => {
        fireEvent.click(drop);
        fireEvent.click(drop);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(store.dismissConflicts).toHaveBeenCalledTimes(1);
      expect(store.dismissConflicts).toHaveBeenCalledWith("tok-2298", [
        expect.objectContaining({
          command: expect.objectContaining({ command_id: "cut-1" }),
        }),
      ]);
      expect(announce).toHaveBeenCalledWith("Dropped your cut at 12:04");
      expect(screen.queryByRole("button", { name: /^Drop it/ })).toBeNull();
    });

    it("looks the conflict up when clicked, so a row the poll already removed does nothing", async () => {
      render(<Queue />);
      await settle();
      await act(async () => conflictRowActions(KEY).onDrop(rowOf("gone")));
      expect(store.dismissConflicts).not.toHaveBeenCalled();
      expect(announce).toHaveBeenCalledWith(
        "That suggestion is no longer listed",
        { tone: "error" },
      );
    });

    it("keeps the row and says why when the store refuses", async () => {
      store.dismissConflicts.mockRejectedValue(new Error("no"));
      render(<Queue />);
      await settle();
      await click(/^Drop it/);
      expect(screen.getByRole("button", { name: /^Drop it/ })).toBeVisible();
      expect(announce).toHaveBeenCalledWith(
        "Could not drop your cut. Try again.",
        { tone: "error" },
      );
    });
  });

  describe("Suggest again here", () => {
    it("sends a fresh target from the current document, never the old payload", async () => {
      render(<Queue />);
      await settle();
      await click(/^Suggest again here/);
      expect(ranges.runRangeAction).toHaveBeenCalledTimes(1);
      const [action, target] = ranges.runRangeAction.mock.calls[0]!;
      expect(action).toBe("cut");
      expect(target).toMatchObject({
        kind: "exact_range",
        intervals: [CUT],
        track_ids: ["guest"],
        media_seals: { guest: "fresh-seal" },
      });
      expect(target.clips.length).toBeGreaterThan(0);
    });

    it("drops the old row once, after the new request was admitted", async () => {
      let admit!: () => void;
      ranges.runRangeAction.mockReturnValue(
        new Promise((resolve) => {
          admit = () => resolve({ status: "ok" });
        }),
      );
      render(<Queue />);
      await settle();
      const again = screen.getByRole("button", { name: /^Suggest again here/ });
      await act(async () => {
        fireEvent.click(again);
        fireEvent.click(again);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(store.dismissConflicts).not.toHaveBeenCalled();
      await act(async () => {
        admit();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(ranges.runRangeAction).toHaveBeenCalledTimes(1);
      expect(store.dismissConflicts).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: /^Drop it/ })).toBeNull();
    });

    it("keeps the row and says why when the span has no audio left", async () => {
      useDawStore.setState({
        project: { ...guestProject(), tracks: [] },
      });
      render(<Queue />);
      await settle();
      await click(/^Suggest again here/);
      expect(ranges.runRangeAction).not.toHaveBeenCalled();
      expect(store.dismissConflicts).not.toHaveBeenCalled();
      expect(announce).toHaveBeenCalledWith(
        "That part of the audio is gone, so there is nothing to suggest again",
        { tone: "error" },
      );
      expect(screen.getByRole("button", { name: /^Drop it/ })).toBeVisible();
    });

    it("keeps the row when the project is not loaded", async () => {
      render(<Queue />);
      await settle();
      useDawStore.setState({ project: null });
      await click(/^Suggest again here/);
      expect(ranges.runRangeAction).not.toHaveBeenCalled();
      expect(store.dismissConflicts).not.toHaveBeenCalled();
      expect(announce).toHaveBeenCalledWith(
        "Open the project to suggest it again",
        { tone: "error" },
      );
    });

    it("keeps the row and announces the reason when the request is not allowed", async () => {
      ranges.runRangeAction.mockResolvedValue({
        status: "disabled",
        reason: "This share cannot suggest edits",
      });
      render(<Queue />);
      await settle();
      await click(/^Suggest again here/);
      expect(store.dismissConflicts).not.toHaveBeenCalled();
      expect(announce).toHaveBeenCalledWith("This share cannot suggest edits", {
        tone: "error",
      });
    });

    it("keeps the row when the request failed before it was admitted", async () => {
      ranges.runRangeAction.mockResolvedValue({
        status: "disabled",
        reason: "Network down",
        told: true,
      });
      render(<Queue />);
      await settle();
      await click(/^Suggest again here/);
      expect(store.dismissConflicts).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: /^Drop it/ })).toBeVisible();
    });

    it("replaces the old row when the server refuses the new request too", async () => {
      ranges.runRangeAction.mockImplementation(async () => {
        store.loadGuestAttention.mockResolvedValue({
          pending: 0,
          conflicts: [staleCut(), staleCut("cut-2")],
        });
        return { status: "disabled", reason: "refused", told: true };
      });
      render(<Queue />);
      await settle();
      await click(/^Suggest again here/);
      expect(store.dismissConflicts).toHaveBeenCalledTimes(1);
      expect(store.dismissConflicts).toHaveBeenCalledWith("tok-2298", [
        expect.objectContaining({
          command: expect.objectContaining({ command_id: "cut-1" }),
        }),
      ]);
    });

    it("says so when the old row cannot be cleared after a new request was admitted", async () => {
      store.dismissConflicts.mockRejectedValue(new Error("no"));
      render(<Queue />);
      await settle();
      await click(/^Suggest again here/);
      expect(announce).toHaveBeenCalledWith(
        "Suggested again, but the old row could not be cleared. Drop it to remove it.",
        { tone: "error" },
      );
    });
  });
});
