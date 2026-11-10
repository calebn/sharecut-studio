import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitDocumentCommand } from "../api/documentEdits";
import { FeedbackToast } from "../feedback/FeedbackToast";
import { resetQueuedCutsForTests } from "../stage/edit/script/cutHits";
import { registerCutToast } from "../stage/edit/script/cutToast";
import { useDawStore } from "../state/dawStore";
import { resetFeedbackRepeatForTests } from "../state/uiSlice";
import { deferred } from "../test/deferred";
import { COMMENTER_CAPABILITIES, clipRow } from "../test/fixtures";
import { scriptUtterance, scriptWord, seedScript } from "../test/scriptHostKit";
import type { CombinedUtterance, HistoryEntryId } from "../types/project";
import { registerCutToastBuilder } from "./cutToastHost";
import { runRangeAction } from "./rangeActions";

vi.mock("../api/documentEdits", async (orig) => ({
  ...(await orig<typeof import("../api/documentEdits")>()),
  submitDocumentCommand: vi.fn(),
}));

const head = (id: string) => id as HistoryEntryId;

const clips = (end = 200) => ({
  clip_count: 2,
  tracks: {
    host: [
      clipRow({
        id: "host-clip",
        track_id: "host",
        source_end: end,
        timeline_end: end,
      }),
    ],
    guest: [
      clipRow({
        id: "guest-clip",
        track_id: "guest",
        source_end: end,
        timeline_end: end,
      }),
    ],
  },
});

const knows = (): CombinedUtterance[] => [
  scriptUtterance("host", "Maya", [
    scriptWord("you", 0, 10),
    scriptWord("know", 1, 10.5),
    scriptWord("so", 2, 11),
    scriptWord("You", 3, 12),
    scriptWord("know,", 4, 12.5),
  ]),
  scriptUtterance("guest", "Anneke", [
    scriptWord("you", 0, 20),
    scriptWord("know", 1, 20.5),
  ]),
];

function select(trackId: string, start: number, end: number) {
  useDawStore.setState({
    selection: {
      kind: "transcriptRange",
      trackId,
      sourceId: null,
      startWordIndex: start,
      endWordIndex: end,
    },
  });
}

function seed(utterances = knows(), extra = {}) {
  seedScript({ utterances, project: { clips: clips() }, ...extra });
  useDawStore.setState({
    stage: "edit",
    projectEpoch: 1,
    rangeBusy: false,
    joinMutationInFlight: false,
  });
}

function withoutWords(trackId: string, keep: number) {
  const { project } = useDawStore.getState();
  useDawStore.setState({
    project: {
      ...project!,
      transcript: {
        utterances: project!.transcript!.utterances.map((u) =>
          u.track_id === trackId ? { ...u, words: u.words!.slice(keep) } : u,
        ),
      },
    },
  });
}

function markCut(trackId: string, upTo: number) {
  const { project } = useDawStore.getState();
  useDawStore.setState({
    project: {
      ...project!,
      transcript: {
        utterances: project!.transcript!.utterances.map((u) =>
          u.track_id === trackId
            ? {
                ...u,
                words: u.words!.map((w, at) =>
                  at < upTo
                    ? {
                        ...w,
                        mappable: false,
                        timeline_start: null,
                        timeline_end: null,
                      }
                    : w,
                ),
              }
            : u,
        ),
      },
    },
  });
}

function stubObserver() {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      callback: (
        entries: { isIntersecting: boolean; intersectionRatio: number }[],
      ) => void;
      constructor(
        callback: (
          entries: { isIntersecting: boolean; intersectionRatio: number }[],
        ) => void,
      ) {
        this.callback = callback;
      }
      observe() {
        this.callback([{ isIntersecting: true, intersectionRatio: 1 }]);
      }
      disconnect() {}
    },
  );
}

const toast = () => useDawStore.getState().feedbackToast;

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.resetAllMocks();
  registerCutToast();
  resetQueuedCutsForTests();
  resetFeedbackRepeatForTests();
  useDawStore.setState({ feedbackToast: null, afterCut: null });
  vi.mocked(submitDocumentCommand).mockResolvedValue({
    type: "Applied",
    history_head_id: "h1",
  });
});

describe("cut toast after a words cut", () => {
  it("names the words, the length and the other occurrences, with Cut all", async () => {
    seed();
    select("host", 0, 1);
    await runRangeAction("cut");
    expect(toast()?.message).toBe('Cut "you know" · 0.9 s · 2 more');
    expect(toast()?.action?.label).toBe("Cut all");
    expect(toast()?.undo).toBe("h1");
  });

  it("counts the same words on every speaker and leaves out the words just cut", async () => {
    seed();
    select("guest", 0, 1);
    await runRangeAction("cut");
    expect(toast()?.message).toContain("2 more");
    select("host", 3, 4);
    await runRangeAction("cut");
    expect(toast()?.message).toContain("1 more");
  });

  it("counts only the occurrences Tab can step to", async () => {
    seed([
      ...knows(),
      scriptUtterance("guest", "Anneke", [
        scriptWord("you", 2, 30),
        scriptWord("know", 3, 30.5, { word_index: undefined }),
      ]),
    ]);
    select("host", 0, 1);
    await runRangeAction("cut");
    expect(toast()?.message).toContain("2 more");
  });

  it("carries the earlier cut of the same words into the next follow", async () => {
    seed();
    select("host", 0, 1);
    await runRangeAction("cut");
    useDawStore.setState({ selection: null });
    select("host", 3, 4);
    await runRangeAction("cut");
    expect(useDawStore.getState().afterCut?.cutKeys).toEqual(
      expect.arrayContaining(["host::0", "host::1", "host::3", "host::4"]),
    );
    expect(toast()?.message).toContain("1 more");
  });

  it.each([
    ["another project epoch", { epoch: 99 }],
    [
      "a history head that is neither of its heads",
      { head: "zz", baseHead: "yy" },
    ],
  ])("does not carry the earlier cut of %s", async (_name, change) => {
    seed();
    const epoch = useDawStore.getState().projectEpoch;
    const head = useDawStore.getState().project?.history?.head_id ?? null;
    useDawStore.setState({
      afterCut: {
        words: "you know",
        cutKeys: ["host::0", "host::1"],
        from: { trackId: "host", sourceId: null, wordIndex: 0 },
        head,
        baseHead: head,
        epoch,
        focused: true,
        holdUntil: Number.MAX_SAFE_INTEGER,
        selected: null,
        at: null,
        startedAt: null,
        direction: null,
        ...change,
      } as never,
    });
    select("host", 3, 4);
    await runRangeAction("cut");
    expect(toast()?.message).toContain("2 more");
    expect(useDawStore.getState().afterCut?.cutKeys).toEqual([
      "host::3",
      "host::4",
    ]);
  });

  it("follows the words only while other occurrences are left", async () => {
    seed();
    select("host", 0, 1);
    await runRangeAction("cut");
    expect(useDawStore.getState().afterCut).toMatchObject({
      words: "you know",
      cutKeys: ["host::0", "host::1"],
      head: "h1",
      selected: null,
    });
    select("host", 2, 2);
    await runRangeAction("cut");
    expect(useDawStore.getState().afterCut).toBeNull();
  });

  it("follows nothing for a cut that is queued, suggested or on the phone", async () => {
    seed();
    vi.mocked(submitDocumentCommand).mockResolvedValue({
      type: "Applied",
      queued: true,
    } as never);
    select("host", 0, 1);
    await runRangeAction("cut");
    expect(useDawStore.getState().afterCut).toBeNull();
    vi.mocked(submitDocumentCommand).mockResolvedValue({
      type: "Applied",
      history_head_id: "h1",
    });
    useDawStore.setState({ shellBreakpoint: "phone" });
    select("host", 0, 1);
    await runRangeAction("cut");
    expect(useDawStore.getState().afterCut).toBeNull();
  });

  it("shows the length alone when no other occurrence is left", async () => {
    seed();
    select("host", 2, 2);
    await runRangeAction("cut");
    expect(toast()?.message).toBe('Cut "so" · 0.4 s');
    expect(toast()?.action).toBeNull();
  });

  it("does not count earlier cut words kept in the transcript", async () => {
    const earlier = knows();
    earlier[0].words = earlier[0].words!.map((w, at) =>
      at < 2
        ? { ...w, mappable: false, timeline_start: null, timeline_end: null }
        : w,
    );
    seed(earlier);
    select("host", 3, 4);
    await runRangeAction("cut");
    expect(toast()?.message).toContain("1 more");
  });

  it("shortens long words to 24 characters", async () => {
    seed([
      scriptUtterance("host", "Maya", [
        scriptWord("internationalization", 0, 10),
        scriptWord("unquestionably", 1, 11),
      ]),
    ]);
    select("host", 0, 1);
    await runRangeAction("cut");
    expect(toast()?.message).toMatch(/^Cut "internationalization un…" · /);
  });

  it("offers no Cut all above 64 other occurrences", async () => {
    const many = Array.from({ length: 66 }, (_, i) =>
      scriptUtterance("host", "Maya", [
        scriptWord("you", i * 2, 1 + i * 2),
        scriptWord("know", i * 2 + 1, 1.5 + i * 2),
      ]),
    );
    seed(many);
    select("host", 0, 1);
    await runRangeAction("cut");
    expect(toast()?.message).toContain("65 more");
    expect(toast()?.action).toBeNull();
  });

  it("offers Cut all at exactly 64 other occurrences", async () => {
    const many = Array.from({ length: 65 }, (_, i) =>
      scriptUtterance("host", "Maya", [
        scriptWord("you", i * 2, 1 + i * 2),
        scriptWord("know", i * 2 + 1, 1.5 + i * 2),
      ]),
    );
    seed(many);
    select("host", 0, 1);
    await runRangeAction("cut");
    expect(toast()?.message).toContain("64 more");
    expect(toast()?.action?.label).toBe("Cut all");
  });

  it("keeps the suggestion copy and no action for someone who may only suggest", async () => {
    seed(knows(), { shareCapabilities: COMMENTER_CAPABILITIES });
    useDawStore.setState({ projectPath: "share:tok", guestMode: "comment" });
    select("host", 0, 1);
    await runRangeAction("cut");
    expect(toast()?.action).toBeNull();
    expect(toast()?.message).not.toContain("more");
  });

  it("keeps the range copy for a cut that did not start from words", async () => {
    seed();
    const { project } = useDawStore.getState();
    const { makeRangeTarget } = await import("../edit/rangeSelection");
    useDawStore.setState({
      selection: {
        kind: "range",
        target: makeRangeTarget(project!, [{ start: 10, end: 11 }], ["host"])!,
      },
    });
    await runRangeAction("cut");
    expect(toast()?.message).toBe("Range cut applied. Use Undo to restore it.");
    expect(toast()?.action).toBeNull();
  });

  it("still cuts with the range copy when building the toast throws", async () => {
    seed(knows());
    registerCutToastBuilder(() => {
      throw new Error("model failed");
    });
    select("host", 0, 1);
    await runRangeAction("cut");
    expect(submitDocumentCommand).toHaveBeenCalledTimes(1);
    expect(toast()?.message).toBe("Range cut applied. Use Undo to restore it.");
    expect(toast()?.action).toBeNull();
  });

  it("is not absorbed as a repeat of the same text", async () => {
    seed();
    select("host", 0, 1);
    await runRangeAction("cut");
    const first = toast()?.id;
    select("host", 0, 1);
    await runRangeAction("cut");
    expect(toast()?.id).not.toBe(first);
  });
});

describe("Cut all on the toast", () => {
  const intervalsOf = (call: number) => {
    const [, , payload] = vi.mocked(submitDocumentCommand).mock.calls[call] as [
      string,
      string,
      { targets: { intervals: unknown[] }[] },
    ];
    return payload.targets.flatMap((t) => t.intervals).length;
  };

  it("leaves out cut words that stay in the transcript as unmappable", async () => {
    seed();
    select("host", 0, 1);
    await runRangeAction("cut");
    markCut("host", 2);
    await toast()!.action!.run();
    expect(intervalsOf(1)).toBe(2);
  });

  it("leaves out the words just cut before the project updates", async () => {
    seed();
    select("host", 0, 1);
    await runRangeAction("cut");
    await toast()!.action!.run();
    expect(intervalsOf(1)).toBe(2);
    expect(useDawStore.getState().statusAnnouncement).toBe("Cut 2 matches");
  });

  it("keeps the first cut's Undo when Cut all fails", async () => {
    seed();
    select("host", 0, 1);
    await runRangeAction("cut");
    useDawStore.setState({ rangeBusy: true });
    await toast()!.action!.run();
    expect(toast()?.tone).toBe("error");
    expect(toast()?.undo).toBe("h1");
  });

  it("cuts the other occurrences as one command", async () => {
    seed();
    select("host", 0, 1);
    await runRangeAction("cut");
    withoutWords("host", 2);
    await toast()!.action!.run();
    expect(submitDocumentCommand).toHaveBeenCalledTimes(2);
    expect(intervalsOf(1)).toBe(2);
    expect(useDawStore.getState().statusAnnouncement).toBe("Cut 2 matches");
  });

  it("reads the live project when it runs, not the project at cut time", async () => {
    seed();
    select("host", 0, 1);
    await runRangeAction("cut");
    withoutWords("host", 2);
    withoutWords("guest", 2);
    await toast()!.action!.run();
    expect(intervalsOf(1)).toBe(1);
  });

  it("says why nothing was cut when no occurrence is left", async () => {
    seed();
    select("host", 0, 1);
    await runRangeAction("cut");
    const { project } = useDawStore.getState();
    useDawStore.setState({
      project: { ...project!, transcript: { utterances: [] } },
    });
    await toast()!.action!.run();
    expect(submitDocumentCommand).toHaveBeenCalledTimes(1);
    expect(toast()?.tone).toBe("error");
    expect(toast()?.message).toBe("No more matches to cut.");
  });

  it("turns a refusal into an error toast", async () => {
    seed();
    select("host", 0, 1);
    await runRangeAction("cut");
    useDawStore.setState({ rangeBusy: true });
    await toast()!.action!.run();
    expect(toast()?.tone).toBe("error");
    expect(toast()?.message).toBe("Wait for the current edit to finish.");
  });

  it("runs once for a double click and disables the button while it runs", async () => {
    seed();
    select("host", 0, 1);
    await runRangeAction("cut");
    withoutWords("host", 2);
    const pending = deferred<Record<string, unknown>>();
    vi.mocked(submitDocumentCommand).mockReturnValue(pending.promise);
    useDawStore.setState((s) => ({
      project: {
        ...s.project!,
        history: { ...s.project!.history!, head_id: head("h1") },
      },
    }));
    stubObserver();
    render(<FeedbackToast />);
    const button = await screen.findByRole("button", { name: "Cut all" });
    await userEvent.dblClick(button);
    expect(submitDocumentCommand).toHaveBeenCalledTimes(2);
    expect(button).toBeDisabled();
    await act(async () => {
      pending.resolve({ type: "Applied", history_head_id: "h2" });
    });
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe("Cut 2 matches"),
    );
    expect(submitDocumentCommand).toHaveBeenCalledTimes(2);
  });

  it("is hidden once the cut can no longer be undone", async () => {
    seed();
    select("host", 0, 1);
    await runRangeAction("cut");
    useDawStore.setState((s) => ({
      project: {
        ...s.project!,
        history: { ...s.project!.history!, head_id: head("h9") },
      },
    }));
    stubObserver();
    render(<FeedbackToast />);
    expect(screen.queryByRole("button", { name: "Cut all" })).toBeNull();
  });
});
