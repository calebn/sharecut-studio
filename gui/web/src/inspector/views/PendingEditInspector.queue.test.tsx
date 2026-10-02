import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PendingCutProposal,
  pendingEditBaseline,
} from "../../api/documentEdits";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, pendingEditView } from "../../test/fixtures";
import { PendingEditInspector } from "./PendingEditInspector";

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
vi.mock("../../state/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/offlineStore")>()),
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
    mocks.approveEdits.mockReset().mockResolvedValue({ queued: true });
    mocks.loadHostCommandQueue.mockReset().mockResolvedValue([]);
    mocks.loadHostConflicts.mockReset().mockResolvedValue([]);
    mocks.loadPendingCutSuggestion.mockReset().mockResolvedValue(proposal);
    mocks.updatePendingEdit
      .mockReset()
      .mockResolvedValue({ queued: true, commandId: command.command_id });
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ pending_edits: [edit] }));
  });

  it("says an approval that is still sending is not done yet", async () => {
    const user = userEvent.setup();
    const { container } = render(<PendingEditInspector edit={edit} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled(),
    );
    mocks.loadHostCommandQueue.mockResolvedValue([
      { ...command, type: "ApproveEdits", payload: { ids: [edit.id] } },
    ]);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Still sending.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("clears Still sending once the queued approval leaves the queue", async () => {
    const user = userEvent.setup();
    render(<PendingEditInspector edit={edit} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled(),
    );
    mocks.loadHostCommandQueue.mockResolvedValue([
      { ...command, type: "ApproveEdits", payload: { ids: [edit.id] } },
    ]);
    await user.click(screen.getByRole("button", { name: "Approve" }));
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
      render(<PendingEditInspector edit={edit} />);
      await screen.findByText("0:09.97525 to 0:12.03525");
      if (!snap)
        await user.click(
          screen.getByRole("checkbox", { name: "Snap to silence" }),
        );
      const start = screen.getByLabelText("Source start");
      const end = screen.getByLabelText("Source end");
      const startText = snap ? "10.01" : "10";
      const endText = snap ? "12.01" : "12";
      await user.clear(start);
      await user.type(start, startText);
      await user.clear(end);
      await user.type(end, endText);
      mocks.loadHostCommandQueue.mockResolvedValue([command]);
      await user.click(screen.getByRole("button", { name: "Apply timing" }));
      expect(await screen.findByRole("status")).toHaveTextContent(
        "Still sending.",
      );
      expect(start).toHaveValue(startText);
      mocks.loadHostCommandQueue.mockResolvedValue([]);
      mocks.loadHostConflicts.mockResolvedValue(
        rejected ? [{ command, reason: "stale" }] : [],
      );
      await waitFor(
        () => {
          expect(screen.queryByRole("status")).toBeNull();
          expect(start).toHaveValue(rejected ? startText : "0:10.000");
          expect(end).toHaveValue(rejected ? endText : "0:12.000");
          const accept = screen.getByRole("button", { name: "Use suggestion" });
          rejected
            ? expect(accept).toBeDisabled()
            : expect(accept).toBeEnabled();
        },
        { timeout: 2500 },
      );
    },
  );

  it("preserves later typing when a queued no-op is acknowledged", async () => {
    const user = userEvent.setup();
    render(<PendingEditInspector edit={edit} />);
    await screen.findByText("0:09.97525 to 0:12.03525");
    fireEvent.change(screen.getByLabelText("Source start"), {
      target: { value: "10.01" },
    });
    mocks.loadHostCommandQueue.mockResolvedValue([command]);
    await user.click(screen.getByRole("button", { name: "Apply timing" }));
    fireEvent.change(screen.getByLabelText("Source start"), {
      target: { value: "10.02" },
    });
    mocks.loadHostCommandQueue.mockResolvedValue([]);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull(), {
      timeout: 2500,
    });
    expect(screen.getByLabelText("Source start")).toHaveValue("10.02");
    expect(
      screen.getByRole("button", { name: "Use suggestion" }),
    ).toBeDisabled();
  });

  it("blocks approval after remount until this edit's durable timing command drains", async () => {
    mocks.loadHostCommandQueue.mockResolvedValue([command]);
    const first = render(<PendingEditInspector edit={edit} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    first.unmount();
    render(<PendingEditInspector edit={edit} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Apply timing" })).toBeDisabled();
    mocks.loadHostCommandQueue.mockResolvedValue([]);
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled(),
      { timeout: 2500 },
    );
  });
});
