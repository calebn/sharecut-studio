import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PendingCutProposal,
  pendingEditBaseline,
} from "../../api/documentEdits";
import { executePointerCommand } from "../../commands/pointer";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, pendingEditView } from "../../test/fixtures";
import { decide } from "../../test/pendingDecision";
import { PendingEditBody } from "./PendingEditBody";

const mocks = vi.hoisted(() => ({
  approveEdits: vi.fn(),
  updatePendingEdit: vi.fn(),
  loadPendingCutSuggestion: vi.fn(),
  loadHostCommandQueue: vi.fn(),
  loadHostConflicts: vi.fn(),
}));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  approveEdits: mocks.approveEdits,
  updatePendingEdit: mocks.updatePendingEdit,
  loadPendingCutSuggestion: mocks.loadPendingCutSuggestion,
}));
vi.mock("../../services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/offlineQueue/offlineStore")
  >()),
  loadHostCommandQueue: mocks.loadHostCommandQueue,
  loadHostConflicts: mocks.loadHostConflicts,
}));

const edit = pendingEditView({
  id: "queued-cut",
  source_start: 10,
  source_end: 12,
  timeline_start: 10,
  timeline_end: 12,
  timebase: "source",
});
const command = {
  command_id: "queued-timing",
  client_id: "fixture-client",
  client_seq: 1,
  created_at: 0,
  type: "UpdatePendingEdit",
  payload: { id: edit.id, start: 10.01, end: 12.01 },
};
const proposal: PendingCutProposal = {
  editId: edit.id,
  trackId: edit.track_id,
  expected: pendingEditBaseline(edit),
  original: { start: 10, end: 12 },
  suggested: { start: 9.97525, end: 12.03525 },
  mode: "waveform_only",
  confidence: 0.5,
  startShiftMs: -24.75,
  endShiftMs: 35.25,
  durationDeltaMs: 60,
};

describe("pending timing queue settlement", () => {
  beforeEach(() => {
    registerDawCommands();
    mocks.approveEdits.mockReset().mockResolvedValue({
      queued: true,
      count: null,
      historyHead: null,
    });
    mocks.loadHostCommandQueue.mockReset().mockResolvedValue([]);
    mocks.loadHostConflicts.mockReset().mockResolvedValue([]);
    mocks.loadPendingCutSuggestion.mockReset().mockResolvedValue(proposal);
    mocks.updatePendingEdit
      .mockReset()
      .mockResolvedValue({ queued: true, commandId: command.command_id });
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ pending_edits: [edit] }));
    useDawStore
      .getState()
      .setSelection({ kind: "pending", id: edit.id, trackId: edit.track_id });
  });

  async function commitField(
    user: ReturnType<typeof userEvent.setup>,
    label: string,
    text: string,
  ) {
    const box = screen.getByRole("spinbutton", { name: label });
    await waitFor(() => expect(box).not.toHaveAttribute("aria-readonly"));
    box.focus();
    await user.keyboard("{Enter}");
    const input = screen.getByRole("textbox", { name: label });
    await user.clear(input);
    await user.type(input, `${text}{Enter}`);
  }

  it("says an approval that is still sending is not done yet", async () => {
    const { container } = render(<PendingEditBody edit={edit} />);
    await waitFor(() =>
      expect(screen.queryByText("Checking queued timing…")).toBeNull(),
    );
    mocks.loadHostCommandQueue.mockResolvedValue([
      { ...command, type: "ApproveEdits", payload: { ids: [edit.id] } },
    ]);
    await decide("cut");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Still sending.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("clears Still sending once the queued approval leaves the queue", async () => {
    render(<PendingEditBody edit={edit} />);
    await waitFor(() =>
      expect(screen.queryByText("Checking queued timing…")).toBeNull(),
    );
    mocks.loadHostCommandQueue.mockResolvedValue([
      { ...command, type: "ApproveEdits", payload: { ids: [edit.id] } },
    ]);
    await decide("cut");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Still sending.",
    );
    mocks.loadHostCommandQueue.mockResolvedValue([]);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull(), {
      timeout: 2500,
    });
  });

  it.each([
    { snap: false, rejected: false },
    { snap: true, rejected: false },
    { snap: false, rejected: true },
    { snap: true, rejected: true },
  ])(
    "settles unchanged bounds with $snap Snap and $rejected rejection",
    async ({ snap, rejected }) => {
      const user = userEvent.setup();
      render(<PendingEditBody edit={edit} />);
      await screen.findByText("0:09.97525 to 0:12.03525");
      if (!snap)
        await user.click(
          screen.getByRole("checkbox", { name: "Snap to silence" }),
        );
      const start = screen.getByRole("spinbutton", { name: "Source start" });
      mocks.loadHostCommandQueue.mockResolvedValue([command]);
      await commitField(user, "Source start", "10.01");
      expect(await screen.findByRole("status")).toHaveTextContent(
        "Still sending.",
      );
      expect(start).toHaveAttribute("aria-readonly", "true");
      expect(start).toHaveAttribute("aria-valuetext", "10.000 s");
      mocks.loadHostCommandQueue.mockResolvedValue([]);
      mocks.loadHostConflicts.mockResolvedValue(
        rejected ? [{ command, reason: "stale" }] : [],
      );
      await waitFor(
        () => {
          expect(screen.queryByRole("status")).toBeNull();
          expect(start).not.toHaveAttribute("aria-readonly");
          expect(start).toHaveAttribute("aria-valuetext", "10.000 s");
          expect(
            screen.getByRole("spinbutton", { name: "Source end" }),
          ).toHaveAttribute("aria-valuetext", "12.000 s");
          expect(
            screen.getByRole("button", { name: "Use suggestion" }),
          ).toBeEnabled();
        },
        { timeout: 2500 },
      );
    },
  );

  it("preserves later typing when a queued no-op is acknowledged", async () => {
    const user = userEvent.setup();
    render(<PendingEditBody edit={edit} />);
    await screen.findByText("0:09.97525 to 0:12.03525");
    mocks.loadHostCommandQueue.mockResolvedValue([command]);
    await commitField(user, "Source start", "10.01");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Still sending.",
    );
    mocks.loadHostCommandQueue.mockResolvedValue([]);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull(), {
      timeout: 2500,
    });
    await commitField(user, "Source start", "10.02");
    expect(mocks.updatePendingEdit).toHaveBeenCalledTimes(2);
    expect(mocks.updatePendingEdit).toHaveBeenLastCalledWith(
      "/tmp/p.json",
      edit.id,
      10.02,
      12,
      true,
      undefined,
      pendingEditBaseline(edit),
    );
  });

  it("blocks approval after remount until this edit's durable timing command drains", async () => {
    mocks.loadHostCommandQueue.mockResolvedValue([command]);
    const first = render(<PendingEditBody edit={edit} />);
    await act(async () => {});
    first.unmount();
    render(<PendingEditBody edit={edit} />);
    await act(async () => {});
    expect(
      screen.getByRole("spinbutton", { name: "Source start" }),
    ).toHaveAttribute("aria-readonly", "true");
    await act(async () => {
      expect(await executePointerCommand("edit.delete")).toEqual({
        status: "disabled",
        reason: "Wait for the current action to finish.",
      });
    });
    expect(mocks.approveEdits).not.toHaveBeenCalled();
    mocks.loadHostCommandQueue.mockResolvedValue([]);
    await waitFor(
      () =>
        expect(
          screen.getByRole("spinbutton", { name: "Source start" }),
        ).not.toHaveAttribute("aria-readonly"),
      { timeout: 2500 },
    );
    await decide("cut");
    expect(mocks.approveEdits).toHaveBeenCalledTimes(1);
  });
});
