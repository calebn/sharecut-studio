import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitDocumentCommand } from "../../api/documentEdits";
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
import { ApiError } from "../../utils/apiError";
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

vi.mock("../../api/documentEdits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/documentEdits")>()),
  submitDocumentCommand: vi.fn(),
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

const dismissedOf = (...conflicts: ReturnType<typeof offlineConflict>[]) => ({
  pending: 0,
  conflicts: conflicts.map((c) => ({ ...c, dismissed: true })),
});

const submit = vi.mocked(submitDocumentCommand);

beforeEach(() => {
  vi.useFakeTimers();
  clearRegisteredCommands();
  registerDawCommands();
  for (const mock of [
    ...Object.values(store),
    submit,
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
  useDawStore.getState().hydrate(KEY, guestProject());
  announce = vi.fn<DawState["announceStatus"]>();
  useDawStore.setState({
    announceStatus: announce,
    shareCapabilities: ["view", "comment", "edit"],
    rangeBusy: false,
  });
});

afterEach(() => {
  clearRegisteredCommands();
  vi.useRealTimers();
});

describe("Suggest again here through the real range action", () => {
  it("replaces the old row once when the server refuses the new cut too", async () => {
    submit.mockImplementation(async () => {
      store.loadGuestAttention.mockResolvedValue({
        pending: 0,
        conflicts: [staleCut(), staleCut("cut-2")],
      });
      throw new ApiError("Selected audio changed", "range_changed", 409);
    });
    render(<Queue />);
    await settle();
    await click(/^Suggest again here/);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![1]).toBe(DocumentCommand.EditSelectedRange);
    expect(submit.mock.calls[0]![2]).toMatchObject({
      action: "cut",
      targets: [{ intervals: [CUT], media_seals: { guest: "fresh-seal" } }],
    });
    expect(announce).toHaveBeenCalledWith(expect.any(String), {
      tone: "error",
    });
    expect(store.dismissConflicts).toHaveBeenCalledTimes(1);
  });

  it("keeps the old row when the request fails and nothing new was queued", async () => {
    submit.mockRejectedValue(new Error("Network down"));
    render(<Queue />);
    await settle();
    await click(/^Suggest again here/);
    expect(announce).toHaveBeenCalledWith("Network down", { tone: "error" });
    expect(store.dismissConflicts).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Drop it/ })).toBeVisible();
  });

  it("applies for an Editor and drops the old row", async () => {
    submit.mockResolvedValue({ type: "Applied" });
    render(<Queue />);
    await settle();
    await click(/^Suggest again here/);
    expect(announce).toHaveBeenCalledWith(
      "Range cut applied. Use Undo to restore it.",
      expect.anything(),
    );
    expect(store.dismissConflicts).toHaveBeenCalledTimes(1);
  });

  it("proposes for a Commenter and drops the old row", async () => {
    useDawStore.setState({ shareCapabilities: ["view", "comment", "suggest"] });
    submit.mockResolvedValue({ type: "Proposed" });
    render(<Queue />);
    await settle();
    await click(/^Suggest again here/);
    expect(announce).toHaveBeenCalledWith(
      "Range suggestion sent for host review",
      {},
    );
    expect(store.dismissConflicts).toHaveBeenCalledTimes(1);
  });
});
