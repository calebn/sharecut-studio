import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { submitDocumentCommand } from "../../../api/documentEdits";
import { useDawStore } from "../../../state/dawStore";
import {
  COMMENTER_CAPABILITIES,
  clipRow,
  EDITOR_CAPABILITIES,
} from "../../../test/fixtures";
import {
  scriptUtterance,
  scriptWord,
  seedScript,
} from "../../../test/scriptHostKit";
import { ApiError } from "../../../utils/apiError";
import { ScriptHost } from "./ScriptHost";

const preview = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
vi.mock("../../../api", async (original) => ({
  ...(await original<typeof import("../../../api")>()),
  previewTranscriptReplacement: preview,
  replaceTranscriptMatches: replace,
}));
vi.mock("../../../api/documentEdits", async (original) => ({
  ...(await original<typeof import("../../../api/documentEdits")>()),
  submitDocumentCommand: vi.fn(),
}));
const queueRows = vi.hoisted(() => ({
  rows: [] as { command_id: string }[],
}));
vi.mock("../../../services/offlineQueue/offlineStore", async (original) => ({
  ...(await original<
    typeof import("../../../services/offlineQueue/offlineStore")
  >()),
  loadHostCommandQueue: vi.fn(async () => queueRows.rows),
  loadCommandQueue: vi.fn(async () => queueRows.rows),
}));
vi.mock("../../../commands/seek", () => ({ seekTransport: vi.fn() }));
const scrolled = vi.hoisted(() => ({ to: [] as number[] }));
vi.mock("../../../system/ScriptPane", async (original) => {
  const actual = await original<typeof import("../../../system/ScriptPane")>();
  const { forwardRef, useImperativeHandle, useRef } = await import("react");
  return {
    ...actual,
    ScriptPane: forwardRef<
      import("../../../system/ScriptPane").ScriptPaneHandle,
      import("../../../system/ScriptPane").ScriptPaneProps
    >((props, ref) => {
      const inner =
        useRef<import("../../../system/ScriptPane").ScriptPaneHandle>(null);
      useImperativeHandle(
        ref,
        () => ({
          focusFind: () => inner.current?.focusFind() ?? false,
          focusWord: (index) => inner.current?.focusWord(index) ?? false,
          scrollToWord: (index, block) => {
            scrolled.to.push(index);
            return inner.current?.scrollToWord(index, block) ?? false;
          },
        }),
        [],
      );
      return <actual.ScriptPane {...props} ref={inner} />;
    }),
  };
});

const CLIPS = {
  clip_count: 2,
  tracks: {
    host: [
      clipRow({
        id: "host-clip",
        track_id: "host",
        source_end: 60,
        timeline_end: 60,
      }),
    ],
    guest: [
      clipRow({
        id: "guest-clip",
        track_id: "guest",
        source_end: 60,
        timeline_end: 60,
      }),
    ],
  },
};

const bar = () => screen.getByRole("search", { name: "Find in transcript" });
const findField = () => screen.getByRole("searchbox", { name: "Find" });

async function openFind() {
  render(<ScriptHost />);
  await userEvent.click(
    screen.getByRole("button", { name: "Find in transcript" }),
  );
}

beforeEach(() => {
  preview.mockReset();
  replace.mockReset();
  preview.mockResolvedValue({
    matches: [],
    count: 2,
    skipped_words: 0,
    preview_token: "tok-1",
  });
  replace.mockResolvedValue({ queued: false });
  queueRows.rows = [];
  vi.mocked(submitDocumentCommand).mockReset();
  vi.mocked(submitDocumentCommand).mockResolvedValue({
    type: "Applied",
    history_head_id: "head-1",
  });
  useDawStore.setState({
    statusAnnouncement: "",
    feedbackToast: null,
    rangeBusy: false,
    joinMutationInFlight: false,
  });
  seedScript();
});

describe("ScriptHost Find", () => {
  it("counts matches and says the count in the pane's live region", async () => {
    await openFind();
    await userEvent.type(findField(), "maya");
    expect(bar()).toHaveTextContent("1 of 1");
    expect(
      screen.getAllByRole("status").map((region) => region.textContent),
    ).toContain("1 of 1");
    await userEvent.clear(findField());
    await userEvent.type(findField(), "zzz");
    expect(bar()).toHaveTextContent("No matches");
  });

  it("marks the current match and steps through the hits with Enter", async () => {
    seedScript({
      utterances: [
        scriptUtterance("host", "Maya", [
          scriptWord("go", 0, 1),
          scriptWord("on", 1, 2),
          scriptWord("go", 2, 3),
        ]),
      ],
    });
    await openFind();
    await userEvent.type(findField(), "go");
    expect(bar()).toHaveTextContent("1 of 2");
    expect(
      screen.getAllByRole("button", { name: /^go/ })[0],
    ).toHaveAccessibleName("go (current match)");
    await userEvent.keyboard("{Enter}");
    expect(bar()).toHaveTextContent("2 of 2");
    expect(
      screen.getAllByRole("button", { name: /^go/ })[1],
    ).toHaveAccessibleName("go (current match)");
    await userEvent.keyboard("{Enter}");
    expect(bar()).toHaveTextContent("1 of 2");
    await userEvent.click(
      screen.getByRole("button", { name: "Previous match" }),
    );
    expect(bar()).toHaveTextContent("2 of 2");
  });

  it("says the same count again when Enter steps onto the only hit", async () => {
    await openFind();
    await userEvent.type(findField(), "maya");
    const spoken = () =>
      screen
        .getAllByRole("status")
        .map((region) => region.textContent)
        .find((text) => text?.includes("1 of 1"));
    const before = spoken();
    await userEvent.keyboard("{Enter}");
    expect(spoken()).not.toBe(before);
    expect(spoken()?.trim()).toBe("1 of 1");
  });

  it("closes on Escape and gives focus back to the Find button", async () => {
    await openFind();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("search")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Find in transcript" }),
    ).toHaveFocus();
  });

  it("selects every hit as one range over their time", async () => {
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: /Select all 1/ }));
    expect(useDawStore.getState().selection?.kind).toBe("range");
  });

  it("finds a phrase another speaker interrupts and selects only its own words", async () => {
    seedScript({
      utterances: [
        scriptUtterance("host", "Maya", [scriptWord("one", 0, 10)]),
        scriptUtterance("guest", "Anneke", [scriptWord("yes", 0, 12)]),
        scriptUtterance("host", "Maya", [scriptWord("thanks", 1, 14)]),
      ],
    });
    await openFind();
    await userEvent.type(findField(), "one thanks");
    expect(bar()).toHaveTextContent("1 of 1");
    expect(
      screen.getAllByRole("status").map((region) => region.textContent),
    ).toContain("1 of 1");
    await userEvent.click(screen.getByRole("button", { name: /Select all 1/ }));
    const selection = useDawStore.getState().selection;
    expect(selection?.kind).toBe("range");
    if (selection?.kind !== "range") return;
    expect(selection.target.track_ids).toEqual(["host"]);
    expect(selection.target.intervals).toEqual([
      { start: 10, end: 10.4 },
      { start: 14, end: 14.4 },
    ]);
  });

  it("scrolls to the first word of each interrupted hit as Next and Previous step", async () => {
    seedScript({
      utterances: [
        scriptUtterance("host", "Maya", [scriptWord("one", 0, 10)]),
        scriptUtterance("guest", "Anneke", [scriptWord("yes", 0, 12)]),
        scriptUtterance("host", "Maya", [scriptWord("thanks", 1, 14)]),
        scriptUtterance("host", "Maya", [scriptWord("one", 2, 20)]),
        scriptUtterance("guest", "Anneke", [scriptWord("yes", 1, 22)]),
        scriptUtterance("host", "Maya", [scriptWord("thanks", 3, 24)]),
      ],
    });
    await openFind();
    await userEvent.type(findField(), "one thanks");
    expect(bar()).toHaveTextContent("1 of 2");
    expect(scrolled.to.at(-1)).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(bar()).toHaveTextContent("2 of 2");
    expect(scrolled.to.at(-1)).toBe(3);
    await userEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(bar()).toHaveTextContent("1 of 2");
    expect(scrolled.to.at(-1)).toBe(0);
    await userEvent.click(
      screen.getByRole("button", { name: "Previous match" }),
    );
    expect(bar()).toHaveTextContent("2 of 2");
    expect(scrolled.to.at(-1)).toBe(3);
  });

  it("replaces all through the preview token and toasts without a count", async () => {
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Show replace" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Replace with" }),
      "Maia",
    );
    await userEvent.click(screen.getByRole("button", { name: "Replace all" }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(preview).toHaveBeenCalledWith("/tmp/ep", {
      search: "maya",
      replacement: "Maia",
      match_case: false,
    });
    expect(replace).toHaveBeenCalledWith(
      "/tmp/ep",
      { search: "maya", replacement: "Maia", match_case: false },
      "tok-1",
    );
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Replaced the matching words",
      ),
    );
    expect(useDawStore.getState().statusAnnouncement).not.toMatch(/\d/);
  });

  it("says a queued replace is still sending, with no count", async () => {
    replace.mockResolvedValue({ queued: true });
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Show replace" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Replace with" }),
      "Maia",
    );
    await userEvent.click(screen.getByRole("button", { name: "Replace all" }));
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Replace queued. Still sending.",
      ),
    );
  });

  it("shows the backend's refusal in the bar", async () => {
    preview.mockResolvedValue({
      matches: [],
      count: 0,
      skipped_words: 3,
      preview_token: "t",
    });
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Show replace" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Replace with" }),
      "Maia",
    );
    await userEvent.click(screen.getByRole("button", { name: "Replace all" }));
    expect(await screen.findByText("No words to replace.")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("offers Replace all only, with no single Replace", async () => {
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Show replace" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Replace with" }),
      "Maia",
    );
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
    expect(screen.getByRole("button", { name: "Replace all" })).toBeVisible();
  });

  const twoSpeakersSayUm = () =>
    seedScript({
      project: { clips: CLIPS },
      utterances: [
        scriptUtterance("host", "Maya", [
          scriptWord("um", 0, 10),
          scriptWord("so", 1, 12),
          scriptWord("um", 2, 20),
        ]),
        scriptUtterance("guest", "Anneke", [
          scriptWord("um", 0, 10.2),
          scriptWord("yes", 1, 25),
          scriptWord("um", 2, 30),
        ]),
      ],
    });

  it("cuts every hit as one command that keeps each speaker's audio apart", async () => {
    twoSpeakersSayUm();
    await openFind();
    await userEvent.type(findField(), "um");
    expect(bar()).toHaveTextContent("1 of 4");
    await userEvent.click(screen.getByRole("button", { name: "Cut all 4" }));
    await waitFor(() => expect(submitDocumentCommand).toHaveBeenCalledTimes(1));
    const [path, type, payload] = vi.mocked(submitDocumentCommand).mock
      .calls[0] as [string, string, { action: string; targets: unknown[] }];
    expect([path, type, payload.action]).toEqual([
      "/tmp/ep",
      "EditSelectedRange",
      "cut",
    ]);
    expect(
      payload.targets.map((target) => {
        const t = target as {
          track_ids: string[];
          intervals: { start: number; end: number }[];
        };
        return [t.track_ids, t.intervals];
      }),
    ).toEqual([
      [
        ["host"],
        [
          { start: 10, end: 10.4 },
          { start: 20, end: 20.4 },
        ],
      ],
      [
        ["guest"],
        [
          { start: 10.2, end: 10.6 },
          { start: 30, end: 30.4 },
        ],
      ],
    ]);
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe("Cut 4 matches"),
    );
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Cut 4 matches",
      undo: "head-1",
    });
  });

  it("says a queued cut is still sending", async () => {
    seedScript({ project: { clips: CLIPS } });
    vi.mocked(submitDocumentCommand).mockResolvedValue({ queued: true });
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Cut all 1" }));
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Cut all queued. Still sending.",
      ),
    );
  });

  it("shows the refusal in the bar and cuts nothing", async () => {
    seedScript({ project: { clips: CLIPS } });
    vi.mocked(submitDocumentCommand).mockRejectedValue(
      new Error("Selected audio changed."),
    );
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Cut all 1" }));
    expect(
      await screen.findByText("Selected audio changed."),
    ).toBeInTheDocument();
    expect(useDawStore.getState().statusAnnouncement).not.toMatch(/^Cut/);
  });

  it("names held matches and says nothing was cut when the server holds a hit", async () => {
    seedScript({ project: { clips: CLIPS } });
    vi.mocked(submitDocumentCommand).mockRejectedValue(
      new ApiError(
        "A selected cut was not applied because the held edges need audio review. Repeat the call with the audio-check override (CLI --override-audio-checks).",
        "cut_scope_changed",
        409,
      ),
    );
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Cut all 1" }));
    expect(
      await screen.findByText(
        "Some of these matches are held for an audio check. Nothing was cut.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/override/)).toBeNull();
    expect(useDawStore.getState().rangeBusy).toBe(false);
  });

  it("does not claim an audio check for another reason the server holds a cut", async () => {
    seedScript({ project: { clips: CLIPS } });
    vi.mocked(submitDocumentCommand).mockRejectedValue(
      new ApiError(
        "A selected cut was not applied because the selected audio no longer has one complete, continuous placement.",
        "cut_scope_changed",
        409,
      ),
    );
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Cut all 1" }));
    expect(
      await screen.findByText("Nothing was cut. The edit was not applied."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/audio check/)).toBeNull();
  });

  it("says what to do when targets overlap on one track", async () => {
    seedScript({ project: { clips: CLIPS } });
    vi.mocked(submitDocumentCommand).mockRejectedValue(
      new ApiError(
        "Two targets cover the same audio.",
        "overlapping_targets",
        409,
      ),
    );
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Cut all 1" }));
    expect(
      await screen.findByText(
        "Some matches overlap on one track, so nothing was cut. Try a narrower search or cut them in the timeline.",
      ),
    ).toBeInTheDocument();
  });

  it("does not say nothing was cut when the server turned the cut into a proposal", async () => {
    seedScript({ project: { clips: CLIPS } });
    vi.mocked(submitDocumentCommand).mockResolvedValue({
      type: "Applied",
      command: { payload: { result: { proposed: true } } },
    });
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Cut all 1" }));
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Cut all was suggested for review. Nothing was cut yet.",
      ),
    );
  });

  it("does not say Cut when the server did not apply the edit", async () => {
    seedScript({ project: { clips: CLIPS } });
    vi.mocked(submitDocumentCommand).mockResolvedValue({ type: "Rejected" });
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Cut all 1" }));
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Nothing was cut. The edit was not applied.",
      ),
    );
    expect(useDawStore.getState().feedbackToast?.undo ?? null).toBeNull();
  });

  it("tells an offline editing guest the cut is queued as a suggestion", async () => {
    seedScript({
      projectPath: "share:abc",
      guestMode: "edit",
      shareCapabilities: EDITOR_CAPABILITIES,
      project: { clips: CLIPS },
    });
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    vi.mocked(submitDocumentCommand).mockResolvedValue({ queued: true });
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Cut all 1" }));
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Cut all queued as a suggestion for host review. Reconnect to send it.",
      ),
    );
    vi.restoreAllMocks();
  });

  it("refuses the same queued cut again after the project object is replaced, but not a different search", async () => {
    seedScript({ project: { clips: CLIPS } });
    vi.mocked(submitDocumentCommand).mockResolvedValue({
      queued: true,
      command_id: "c1",
    });
    queueRows.rows = [{ command_id: "c1" }];
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Cut all 1" }));
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Cut all queued. Still sending.",
      ),
    );
    act(() => {
      useDawStore.setState({ project: { ...useDawStore.getState().project! } });
    });
    await userEvent.click(screen.getByRole("button", { name: "Cut all 1" }));
    expect(
      await screen.findByText(
        "Cut all is already queued. Wait for it to send.",
      ),
    ).toBeInTheDocument();
    expect(submitDocumentCommand).toHaveBeenCalledTimes(1);
    await userEvent.clear(findField());
    await userEvent.type(findField(), "so");
    await userEvent.click(screen.getByRole("button", { name: /^Cut all/ }));
    await waitFor(() => expect(submitDocumentCommand).toHaveBeenCalledTimes(2));
  });

  it("queues a Cut all once and refuses a second click until the project changes", async () => {
    seedScript({ project: { clips: CLIPS } });
    vi.mocked(submitDocumentCommand).mockResolvedValue({
      queued: true,
      command_id: "c1",
    });
    queueRows.rows = [{ command_id: "c1" }];
    await openFind();
    await userEvent.type(findField(), "maya");
    const button = screen.getByRole("button", { name: "Cut all 1" });
    await userEvent.click(button);
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Cut all queued. Still sending.",
      ),
    );
    await userEvent.click(button);
    expect(
      await screen.findByText(
        "Cut all is already queued. Wait for it to send.",
      ),
    ).toBeInTheDocument();
    expect(submitDocumentCommand).toHaveBeenCalledTimes(1);
    expect(useDawStore.getState().rangeBusy).toBe(false);
  });

  it("cuts again when the queued Cut all was rejected on replay", async () => {
    seedScript({ project: { clips: CLIPS } });
    vi.mocked(submitDocumentCommand).mockResolvedValueOnce({
      queued: true,
      command_id: "c1",
    });
    queueRows.rows = [{ command_id: "c1" }];
    await openFind();
    await userEvent.type(findField(), "maya");
    const button = screen.getByRole("button", { name: "Cut all 1" });
    await userEvent.click(button);
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Cut all queued. Still sending.",
      ),
    );
    queueRows.rows = [];
    await userEvent.click(button);
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe("Cut 1 match"),
    );
    expect(submitDocumentCommand).toHaveBeenCalledTimes(2);
  });

  it("cuts again when the queued Cut all applied and was then undone", async () => {
    seedScript({ project: { clips: CLIPS } });
    vi.mocked(submitDocumentCommand).mockResolvedValueOnce({
      queued: true,
      command_id: "c1",
    });
    queueRows.rows = [{ command_id: "c1" }];
    await openFind();
    await userEvent.type(findField(), "maya");
    const button = screen.getByRole("button", { name: "Cut all 1" });
    await userEvent.click(button);
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Cut all queued. Still sending.",
      ),
    );
    queueRows.rows = [];
    act(() => {
      useDawStore.setState({ project: { ...useDawStore.getState().project! } });
    });
    await userEvent.click(button);
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe("Cut 1 match"),
    );
    expect(submitDocumentCommand).toHaveBeenCalledTimes(2);
  });

  it("says a host that is offline queued its own cut, not a suggestion", async () => {
    seedScript({ project: { clips: CLIPS } });
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    vi.mocked(submitDocumentCommand).mockResolvedValue({
      queued: true,
      command_id: "c1",
    });
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Cut all 1" }));
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Cut all queued. Still sending.",
      ),
    );
    vi.restoreAllMocks();
  });

  it("leaves a new project's busy flag alone when a cut finishes after a project switch", async () => {
    seedScript({ project: { clips: CLIPS } });
    let finish!: (value: Record<string, unknown>) => void;
    vi.mocked(submitDocumentCommand).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await openFind();
    await userEvent.type(findField(), "maya");
    await userEvent.click(screen.getByRole("button", { name: "Cut all 1" }));
    await waitFor(() => expect(useDawStore.getState().rangeBusy).toBe(true));
    act(() => {
      useDawStore.setState({
        projectEpoch: useDawStore.getState().projectEpoch + 1,
        rangeBusy: true,
      });
    });
    await act(async () => {
      finish({ type: "Applied", history_head_id: "head-1" });
    });
    expect(useDawStore.getState().rangeBusy).toBe(true);
  });

  it.each([
    ["rangeBusy", { rangeBusy: true }],
    ["joinMutationInFlight", { joinMutationInFlight: true }],
  ])(
    "refuses Cut all while %s is set and leaves it alone",
    async (_name, busy) => {
      seedScript({ project: { clips: CLIPS } });
      await openFind();
      await userEvent.type(findField(), "maya");
      useDawStore.setState(busy);
      await userEvent.click(screen.getByRole("button", { name: "Cut all 1" }));
      expect(
        await screen.findByText("Wait for the current edit to finish."),
      ).toBeInTheDocument();
      expect(submitDocumentCommand).not.toHaveBeenCalled();
      expect(useDawStore.getState()).toMatchObject(busy);
    },
  );

  it("releases rangeBusy after a cut lands and after one fails", async () => {
    seedScript({ project: { clips: CLIPS } });
    await openFind();
    await userEvent.type(findField(), "maya");
    const button = screen.getByRole("button", { name: "Cut all 1" });
    await userEvent.click(button);
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe("Cut 1 match"),
    );
    expect(useDawStore.getState().rangeBusy).toBe(false);
    vi.mocked(submitDocumentCommand).mockRejectedValue(new Error("Nope."));
    await userEvent.click(button);
    expect(await screen.findByText("Nope.")).toBeInTheDocument();
    expect(useDawStore.getState().rangeBusy).toBe(false);
  });

  it("offers no Cut all to a suggesting guest", async () => {
    seedScript({
      projectPath: "share:abc",
      guestMode: "comment",
      shareCapabilities: COMMENTER_CAPABILITIES,
    });
    await openFind();
    await userEvent.type(findField(), "maya");
    expect(screen.queryByRole("button", { name: /Cut all/ })).toBeNull();
  });

  it("offers Cut all to an editing guest", async () => {
    seedScript({
      projectPath: "share:abc",
      guestMode: "edit",
      shareCapabilities: EDITOR_CAPABILITIES,
      project: { clips: CLIPS },
    });
    await openFind();
    await userEvent.type(findField(), "maya");
    expect(screen.getByRole("button", { name: "Cut all 1" })).toBeVisible();
  });
});
