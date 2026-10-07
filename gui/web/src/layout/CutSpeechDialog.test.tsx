import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/commandQueue", () => ({
  submitQueuedDocumentCommand: vi.fn(),
}));
vi.mock("../api/boundary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/boundary")>()),
  loadBoundaryContext: vi.fn(),
}));

import { loadBoundaryContext } from "../api/boundary";
import {
  approveEdits,
  askIfReplayHeldBack,
  trimClipEdge,
} from "../api/documentEdits";
import { clearRegisteredCommands, execute } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import type { CutSpeech } from "../edit/cutSpeech";
import { submitQueuedDocumentCommand } from "../services/commandQueue";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { CutSpeechDialog } from "./CutSpeechDialog";
import { CutSpeechDialogView } from "./CutSpeechDialogView";

const submit = vi.mocked(submitQueuedDocumentCommand);

const SPEECH: CutSpeech = {
  spans: [{ start: 8, end: 10 }],
  tracks: [
    {
      track_id: "guest",
      speaker: "Avery",
      words: [
        { text: "so", timeline_start: 8.2, timeline_end: 8.4 },
        { text: "the", timeline_start: 8.4, timeline_end: 8.6 },
        { text: "plan", timeline_start: 8.6, timeline_end: 9.0 },
      ],
      sound_spans: [],
    },
  ],
};

const ASKED = {
  ok: true,
  needs_confirmation: {
    status: "needs_confirmation",
    reason: "cuts_other_speech",
    message: "This also cuts Avery's speech.",
    confirm_label: "Cut anyway",
    confirm_field: "confirm_cut_speech",
    speech: SPEECH,
  },
};

function project() {
  return minimalProject({
    tracks: [
      sampleTrack({ id: "host", speaker: "Caleb" }),
      sampleTrack({ id: "guest", speaker: "Avery" }),
    ],
    clips: {
      tracks: {
        host: [
          {
            id: "h2",
            track_id: "host",
            source_start: 8,
            source_end: 20,
            timeline_start: 8,
            timeline_end: 20,
            fade_in_ms: 0,
            fade_out_ms: 0,
            join_in_mode: "fade",
            source_id: null,
          },
        ],
      },
      clip_count: 1,
    },
  });
}

/** The first command the host holds back; every later one applies. */
function askOnce() {
  submit.mockReset();
  submit.mockResolvedValueOnce(ASKED).mockResolvedValue({ ok: true });
}

function sent(index: number) {
  const call = submit.mock.calls[index];
  return call ? { type: call[1], payload: call[2] } : undefined;
}

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  askOnce();
  useDawStore.setState({
    projectPath: "/tmp/ep",
    guestMode: null,
    shareCapabilities: null,
    project: project(),
    selection: { kind: "clip", id: "h2", trackId: "host" },
    cutSpeechPrompt: null,
    statusAnnouncement: "",
  });
});

describe("CutSpeechDialog", () => {
  it("asks before a ripple delete cuts another speaker, naming who, when and what", async () => {
    render(<CutSpeechDialog />);

    expect(await execute("edit.rippleDelete")).toEqual({ status: "ok" });

    expect(
      await screen.findByRole("dialog", { name: "Cut Avery's speech too?" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent(
      "Avery at 0:08.2: “so the plan”",
    );
    expect(useDawStore.getState().statusAnnouncement).not.toMatch(/deleted/i);
    expect(useDawStore.getState().selection).toEqual({
      kind: "clip",
      id: "h2",
      trackId: "host",
    });
    await expectNoA11yViolations(document.body);
  });

  it("Leave a gap resubmits the delete in gap mode", async () => {
    const user = userEvent.setup();
    render(<CutSpeechDialog />);
    await execute("edit.rippleDelete");

    await user.click(
      await screen.findByRole("button", { name: "Leave a gap" }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent(1)).toEqual({
      type: "DeleteClip",
      payload: { clip_ids: ["h2"], mode: "gap" },
    });
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Left a gap. Avery's speech stays.",
    );
  });

  it("Cut anyway resubmits the same ripple confirmed", async () => {
    const user = userEvent.setup();
    render(<CutSpeechDialog />);
    await execute("edit.cut");

    await user.click(await screen.findByRole("button", { name: "Cut anyway" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent(1)).toEqual({
      type: "DeleteClip",
      payload: { clip_ids: ["h2"], mode: "ripple", confirm_cut_speech: true },
    });
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Cut, including Avery's speech. Undo restores it.",
    );
  });

  it("Leave a gap on a trim mints a gap-mode token for the same edge", async () => {
    const user = userEvent.setup();
    vi.mocked(loadBoundaryContext).mockResolvedValue({
      token: "gap-token",
    } as Awaited<ReturnType<typeof loadBoundaryContext>>);
    render(<CutSpeechDialog />);

    expect(
      await trimClipEdge("/tmp/ep", "h2", "out", 10, "ripple", "ripple-token"),
    ).toEqual({ queued: false, asked: true });
    await user.click(
      await screen.findByRole("button", { name: "Leave a gap" }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(loadBoundaryContext).toHaveBeenCalledWith(
      "/tmp/ep",
      { kind: "trim", clip_id: "h2", edge: "out", mode: "gap" },
      [
        {
          id: "h2",
          source_start: 8,
          source_end: 20,
          timeline_start: 8,
          source_id: null,
        },
      ],
    );
    expect(sent(1)).toEqual({
      type: "TrimClipEdge",
      payload: {
        clip_id: "h2",
        edge: "out",
        source_sec: 10,
        mode: "gap",
        expected_token: "gap-token",
      },
    });
  });

  it("approving a suggestion that cuts speech offers Cancel instead of a gap", async () => {
    const user = userEvent.setup();
    render(<CutSpeechDialog />);

    expect(await approveEdits("/tmp/ep", ["e1"])).toEqual({
      queued: false,
      asked: true,
      historyHead: null,
    });
    expect(
      await screen.findByRole("button", { name: "Cancel" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Leave a gap" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Cut anyway" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent(1)).toEqual({
      type: "ApproveEdits",
      payload: { ids: ["e1"], confirm_cut_speech: true },
    });
  });

  it("asks for a queued ripple the host held back on replay", async () => {
    const user = userEvent.setup();
    submit.mockReset().mockResolvedValue({ ok: true });
    render(<CutSpeechDialog />);

    askIfReplayHeldBack(
      "/tmp/ep",
      "DeleteClip",
      { clip_ids: ["h2"], mode: "ripple" },
      ASKED,
    );
    await user.click(
      await screen.findByRole("button", { name: "Leave a gap" }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent(0)).toEqual({
      type: "DeleteClip",
      payload: { clip_ids: ["h2"], mode: "gap" },
    });
  });

  it("keeps the choice open with the reason when the resubmit fails", async () => {
    const user = userEvent.setup();
    submit
      .mockReset()
      .mockResolvedValueOnce(ASKED)
      .mockRejectedValueOnce(new Error("The clip changed"));
    render(<CutSpeechDialog />);
    await execute("edit.rippleDelete");

    await user.click(await screen.findByRole("button", { name: "Cut anyway" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The clip changed",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Close dismisses without changing anything", async () => {
    const user = userEvent.setup();
    render(<CutSpeechDialog />);
    await execute("edit.rippleDelete");

    await user.click(await screen.findByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useDawStore.getState().cutSpeechPrompt).toBeNull();
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe("CutSpeechDialogView", () => {
  it("lists speakers in time order and names untranscribed speech", async () => {
    render(
      <CutSpeechDialogView
        speech={{
          spans: [{ start: 12, end: 14 }],
          tracks: [
            {
              track_id: "sam",
              speaker: "Sam",
              words: [
                { text: "right", timeline_start: 13.4, timeline_end: 13.6 },
              ],
              sound_spans: [],
            },
            {
              track_id: "lee",
              speaker: "Lee",
              words: [],
              sound_spans: [{ start: 12.5, end: 13 }],
            },
          ],
        }}
        canLeaveGap={false}
        busy={false}
        error={null}
        onCutAnyway={vi.fn()}
        onLeaveGap={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Cut Lee and Sam's speech too?" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual([
      "Lee at 0:12.5: speech not in the transcript",
      "Sam at 0:13.4: “right”",
    ]);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await expectNoA11yViolations(document.body);
  });
});
