import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/commandQueue", () => ({
  submitQueuedDocumentCommand: vi.fn(),
}));
vi.mock("../../api/documentTransport", () => ({
  hostFetch: vi.fn(() => new Promise(() => {})),
}));
vi.mock("../../state/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/offlineStore")>()),
  loadHostCommandCount: vi.fn(async () => 0),
}));

import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import type { CutSpeech } from "../../edit/cutSpeech";
import { CutSpeechDialog } from "../../layout/CutSpeechDialog";
import { submitQueuedDocumentCommand } from "../../services/commandQueue";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject } from "../../test/fixtures";
import type { PendingEditView } from "../../types/project";
import { PendingEditInspector } from "./PendingEditInspector";

const submit = vi.mocked(submitQueuedDocumentCommand);

const SPEECH: CutSpeech = {
  spans: [{ start: 1400.01, end: 1400.73 }],
  tracks: [
    {
      track_id: "caleb",
      speaker: "Caleb",
      words: [{ text: "right", timeline_start: 1400.2, timeline_end: 1400.5 }],
      sound_spans: [],
    },
  ],
};

const ASKED = {
  ok: true,
  unchanged: true,
  needs_confirmation: {
    status: "needs_confirmation",
    reason: "cuts_other_speech",
    message: "This also cuts Caleb's speech.",
    confirm_label: "Cut anyway",
    confirm_field: "confirm_cut_speech",
    speech: SPEECH,
  },
};

const guardBlockedFiller: PendingEditView = {
  id: "filler_like_1400",
  track_id: "audra",
  track_ids: ["audra"],
  type: "remove",
  reason: "filler:like:other_speaking:caleb",
  source_start: 1400.01,
  source_end: 1400.73,
  source_start_timeline: 1400.01,
  source_end_timeline: 1400.73,
  timeline_start: 1400.01,
  timeline_end: 1400.73,
  timeline_spans: [{ start: 1400.01, end: 1400.73 }],
  mappable: true,
  crossfade_ms: 10,
  boundary_mode: "exact",
  cut_confidence: 0.9,
  review_required: true,
  harsh: false,
  applied: false,
  suggest_reason: null,
  timebase: "source",
  scope: "session",
};

function sent(index: number) {
  const call = submit.mock.calls[index];
  return call ? { type: call[1], payload: call[2] } : undefined;
}

describe("approving a filler a peer speaks over", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    submit.mockReset();
    submit.mockResolvedValueOnce(ASKED).mockResolvedValue({
      ok: true,
      command: { payload: { result: { count: 1 } } },
    });
    useDawStore.getState().hydrate("/tmp/ep.json", {
      ...minimalProject(),
      pending_edits: [guardBlockedFiller],
    });
    useDawStore.setState({ cutSpeechPrompt: null, statusAnnouncement: "" });
  });

  it("asks Cut anyway through the shared dialog, then ripples confirmed", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PendingEditInspector edit={guardBlockedFiller} />
        <CutSpeechDialog />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Cut Caleb's speech too?",
    });
    expect(sent(0)).toEqual({
      type: "ApproveEdits",
      payload: { ids: ["filler_like_1400"], allow_review: true },
    });
    expect(screen.queryByRole("button", { name: "Leave a gap" })).toBeNull();
    await expectNoA11yViolations(dialog);

    await user.click(screen.getByRole("button", { name: "Cut anyway" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent(1)).toEqual({
      type: "ApproveEdits",
      payload: {
        ids: ["filler_like_1400"],
        allow_review: true,
        confirm_cut_speech: true,
      },
    });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("closes the dialog as soon as Cut anyway is chosen, before the confirmed approve returns", async () => {
    const user = userEvent.setup();
    let releaseSecond: (value: object) => void = () => {};
    const secondHeld = new Promise<object>((resolve) => {
      releaseSecond = resolve;
    });
    submit.mockReset();
    submit
      .mockResolvedValueOnce(ASKED)
      .mockImplementationOnce(() => secondHeld);

    render(
      <>
        <PendingEditInspector edit={guardBlockedFiller} />
        <CutSpeechDialog />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await user.click(await screen.findByRole("button", { name: "Cut anyway" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDawStore.getState().cutSpeechPrompt).toBeNull();

    releaseSecond({
      ok: true,
      command: { payload: { result: { count: 1 } } },
    });
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  });

  it("Cancel leaves the filler pending and sends nothing more", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PendingEditInspector edit={guardBlockedFiller} />
        <CutSpeechDialog />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(submit).toHaveBeenCalledTimes(1);
    expect(useDawStore.getState().project?.pending_edits).toHaveLength(1);
  });
});
