import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { submitDocumentCommand } from "../api/documentEdits";
import { clearRegisteredCommands } from "../commands/execute";
import { registerRangeCommands } from "../commands/rangeActions";
import { setClipboard } from "../edit/clipboard";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import {
  COMMENTER_CAPABILITIES,
  clipRow,
  minimalProject,
  sampleTrack,
} from "../test/fixtures";
import { RangeActions } from "../timeline/RangeActions";
import { TranscriptPanel } from "./TranscriptPanel";

vi.mock("../api/documentEdits", () => ({ submitDocumentCommand: vi.fn() }));

const project = minimalProject({
  timeline_duration_sec: 4,
  tracks: [sampleTrack({ id: "host", range_media_seal: "seal" })],
  clips: {
    tracks: {
      host: [
        clipRow({
          track_id: "host",
          source_start: 0,
          source_end: 4,
          timeline_start: 0,
          timeline_end: 4,
        }),
      ],
    },
    clip_count: 1,
  },
  transcript: {
    utterances: [
      {
        track_id: "host",
        speaker: "Host",
        start: 0,
        end: 2,
        text: "Um. Welcome",
        mappable: true,
        timeline_start: 0,
        timeline_end: 2,
        words: [
          { text: "Um.", start: 0.5, end: 0.9, word_index: 0 },
          { text: "Welcome", start: 1, end: 2, word_index: 1 },
        ].map((w) => ({ ...w, timeline_start: w.start, timeline_end: w.end })),
      },
    ],
  },
});

const VIEW = ["play", "view"];
const SUGGEST = COMMENTER_CAPABILITIES;
const EDIT = [...COMMENTER_CAPABILITIES, "edit"];

function openShare(capabilities: string[]) {
  useDawStore.setState({
    project,
    projectPath: "share:tok",
    guestMode: capabilities.includes("edit")
      ? "edit"
      : capabilities.includes("suggest")
        ? "comment"
        : "view",
    shareCapabilities: capabilities,
    projectEpoch: 1,
    selection: null,
    rangeArmed: false,
    rangeBusy: false,
    joinMutationInFlight: false,
    sessionRegion: null,
    selectedTrackIds: [],
    statusAnnouncement: "",
  });
  return render(
    <main>
      <TranscriptPanel />
      <RangeActions />
    </main>,
  );
}

function selectUm(container: HTMLElement) {
  const q = within(container);
  fireEvent.click(q.getByRole("button", { name: /^Select:/ }));
  fireEvent.click(q.getByRole("button", { name: "Um." }));
}

beforeEach(() => {
  vi.resetAllMocks();
  clearRegisteredCommands();
  registerRangeCommands();
  setClipboard(null);
});

describe("guest transcript Select follows share capabilities", () => {
  it("a view/play/comment guest gets no Select and no word range", async () => {
    const { container } = openShare(VIEW);
    const q = within(container);
    expect(q.queryByRole("group", { name: "Transcript mode" })).toBeNull();
    expect(q.queryByRole("button", { name: /^Select:/ })).toBeNull();
    fireEvent.click(q.getByRole("button", { name: "Um." }));
    expect(useDawStore.getState().selection).toBeNull();
    expect(screen.queryByRole("region", { name: "Range actions" })).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("a suggest guest selects words and Suggest cut sends a pending suggestion", async () => {
    vi.mocked(submitDocumentCommand).mockResolvedValue({ type: "Applied" });
    const { container } = openShare(SUGGEST);
    const q = within(container);
    expect(q.queryByRole("button", { name: /^Correct/ })).toBeNull();
    expect(q.queryByRole("button", { name: /^Ignore/ })).toBeNull();
    selectUm(container);
    expect(useDawStore.getState().selection).toEqual({
      kind: "transcriptRange",
      trackId: "host",
      startWordIndex: 0,
      endWordIndex: 0,
    });
    expect(container.querySelector(".transcript-mode-hint")).toHaveTextContent(
      "sends them to the host for review",
    );
    expect(q.queryByRole("button", { name: "Cut" })).toBeNull();
    await act(async () => {
      fireEvent.click(q.getByRole("button", { name: "Suggest cut" }));
    });
    expect(submitDocumentCommand).toHaveBeenCalledExactlyOnceWith(
      "share:tok",
      "EditSelectedRange",
      {
        action: "cut",
        target: expect.objectContaining({
          intervals: [{ start: 0.5, end: 0.9 }],
          track_ids: ["host"],
        }),
      },
    );
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Range suggestion sent for host review",
    );
    await expectNoA11yViolations(container);
  });

  it("an edit guest selects words and Cut applies like the host", async () => {
    vi.mocked(submitDocumentCommand).mockResolvedValue({ type: "Applied" });
    const { container } = openShare(EDIT);
    const q = within(container);
    expect(q.queryByRole("button", { name: /^Correct/ })).toBeNull();
    selectUm(container);
    expect(container.querySelector(".transcript-mode-hint")).toHaveTextContent(
      "edits the timeline",
    );
    expect(q.queryByRole("button", { name: "Suggest cut" })).toBeNull();
    await act(async () => {
      fireEvent.click(q.getByRole("button", { name: "Cut" }));
    });
    expect(submitDocumentCommand).toHaveBeenCalledExactlyOnceWith(
      "share:tok",
      "EditSelectedRange",
      {
        action: "cut",
        target: expect.objectContaining({
          intervals: [{ start: 0.5, end: 0.9 }],
        }),
      },
    );
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Range cut applied. Use Undo to restore it.",
    );
    expect(useDawStore.getState().selection).toBeNull();
    await expectNoA11yViolations(container);
  });
});
