import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCommentAnchor } from "../../comments/commentAnchor";
import {
  type SettledTranscript,
  shownTranscriptOf,
} from "../../document/shownTranscript";
import {
  resolveSelectionRange,
  TRANSCRIPT_REFRESHING,
} from "../../edit/rangeSelection";
import { useDawStore } from "../../state/dawStore";
import { COMMENTER_CAPABILITIES } from "../../test/fixtures";
import { drag, layout } from "../../test/scriptDrag";
import {
  scriptUtterance,
  scriptUtterances,
  scriptWord,
  seedScript,
  TWO_LANE_CLIPS,
} from "../../test/scriptHostKit";
import { stubViewportShell } from "../../test/viewportShell";
import type { CombinedUtterance } from "../../types/project";
import { GuestScriptHost } from "./GuestScriptHost";

vi.mock("../../commands/seek", () => ({ seekTransport: vi.fn() }));

const GRANT = "g";
const SPOKEN = [
  ["Welcome", "back", "to", "the", "show", "friends"],
  ["Hello", "again", "everyone"],
];
/** Host lines of a Script; `at` shifts the second line the way a ripple cut earlier does. */
function lines(
  first: string[],
  second: string[],
  at: number,
): CombinedUtterance[] {
  const build = (texts: string[], from: number, start: number, shift: number) =>
    scriptUtterance(
      "host",
      "Maya",
      texts.map((text, i) =>
        scriptWord(text, from + i, start + i * 0.5, {
          timeline_start: start + i * 0.5 + shift,
          timeline_end: start + i * 0.5 + shift + 0.4,
        }),
      ),
      { timeline_start: start + shift },
    );
  return [build(first, 0, 10, 0), build(second, first.length, 20, at)];
}
const COMPLETE = lines(SPOKEN[0]!, SPOKEN[1]!, 0);
const settled: SettledTranscript = { grant: GRANT, utterances: COMPLETE };
const headers = (rows: CombinedUtterance[]) =>
  rows.map(({ words: _words, ...rest }) => rest);
const live = (rows: CombinedUtterance[]) =>
  shownTranscriptOf({ utterances: rows } as never, null, GRANT, true);
const refreshing = (rows: CombinedUtterance[]) =>
  shownTranscriptOf(
    { utterances: headers(rows) } as never,
    settled,
    GRANT,
    false,
  );

function mount(shown: ReturnType<typeof live>) {
  const view = render(<GuestScriptHost shown={shown} />);
  return Object.assign(
    (next: ReturnType<typeof live>) =>
      act(() => view.rerender(<GuestScriptHost shown={next} />)),
    { unmount: view.unmount },
  );
}
const selected = () =>
  [...document.querySelectorAll("[data-selected]")].map((el) =>
    el.textContent?.trim(),
  );
const stored = () => useDawStore.getState().selection;

beforeEach(() => {
  stubViewportShell("desktop");
  layout();
  seedScript({
    projectPath: "share:abc",
    guestMode: "comment",
    shareCapabilities: COMMENTER_CAPABILITIES,
    utterances: COMPLETE,
    project: { clips: TWO_LANE_CLIPS },
  });
  useDawStore.setState({ feedbackToast: null });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
});

describe("a selection across an edit", () => {
  it("follows its words when a ripple cut before them renumbers the line", () => {
    const rerender = mount(live(COMPLETE));
    drag(6, 8);
    expect(stored()).toMatchObject({
      kind: "transcriptRange",
      startWordIndex: 6,
      endWordIndex: 8,
    });
    expect(selected().join(" ")).toContain("Hello");
    const cut = lines(
      ["Welcome", "to", "the", "show", "friends"],
      SPOKEN[1]!,
      -0.5,
    );
    rerender(refreshing(cut));
    expect(stored()).toMatchObject({ startWordIndex: 6, endWordIndex: 8 });
    rerender(live(cut));
    expect(stored()).toMatchObject({
      kind: "transcriptRange",
      startWordIndex: 5,
      endWordIndex: 7,
    });
    expect(selected().join(" ")).toContain("Hello");
    expect(selected().join(" ")).toContain("everyone");
  });

  it("is cleared when the cut went through its words", () => {
    const rerender = mount(live(COMPLETE));
    drag(3, 4);
    expect(stored()?.kind).toBe("transcriptRange");
    const cut = lines(
      ["Welcome", "back", "to", "show", "friends"],
      SPOKEN[1]!,
      -0.5,
    );
    rerender(refreshing(cut));
    expect(stored()?.kind).toBe("transcriptRange");
    rerender(live(cut));
    expect(stored()).toBeNull();
  });

  it("is left alone by a correction on another line", () => {
    const rerender = mount(live(COMPLETE));
    drag(6, 8);
    const before = stored();
    const fixed = lines(
      ["Welcome", "back", "to", "this", "show", "friends"],
      SPOKEN[1]!,
      0,
    );
    rerender(refreshing(fixed));
    expect(stored()).toBe(before);
    rerender(live(fixed));
    expect(stored()).toBe(before);
  });
});

describe("a selection across an edit that only renumbers", () => {
  /** A struck "um" opens the first line: it takes no place in the Script. */
  const struckOpening = (kept: boolean) => {
    const rows = lines(
      kept ? ["um", ...SPOKEN[0]!] : SPOKEN[0]!,
      SPOKEN[1]!,
      0,
    );
    if (kept) rows[0]!.words![0]!.ignored = true;
    return rows;
  };

  it("follows its words when the cut took only a struck word before them", () => {
    seedScript({
      projectPath: "share:abc",
      guestMode: "comment",
      shareCapabilities: COMMENTER_CAPABILITIES,
      utterances: struckOpening(true),
      project: { clips: TWO_LANE_CLIPS },
    });
    const rerender = mount(live(struckOpening(true)));
    drag(6, 8);
    expect(stored()).toMatchObject({ startWordIndex: 7, endWordIndex: 9 });
    useDawStore.setState({ feedbackToast: null });
    const gone = struckOpening(false);
    rerender(refreshing(gone));
    expect(useDawStore.getState().feedbackToast).toBeNull();
    expect(stored()).toMatchObject({ startWordIndex: 7, endWordIndex: 9 });
    rerender(live(gone));
    expect(stored()).toMatchObject({ startWordIndex: 6, endWordIndex: 8 });
    expect(useDawStore.getState().feedbackToast).toBeNull();
  });

  it("announces nothing while a held line waits and at the swap, when the guest did nothing", () => {
    const rerender = mount(live(COMPLETE));
    drag(6, 8);
    useDawStore.setState({ feedbackToast: null });
    const say = vi.spyOn(useDawStore.getState(), "announceStatus");
    const cut = lines(
      ["Welcome", "to", "the", "show", "friends"],
      SPOKEN[1]!,
      -0.5,
    );
    rerender(refreshing(cut));
    rerender(refreshing(cut));
    rerender(live(cut));
    expect(say).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({ startWordIndex: 5, endWordIndex: 7 });
  });
});

describe("a selection is the same word, found by its place in the recording", () => {
  const word = (text: string, n: number, at: number, shift: number) =>
    scriptWord(text, n, at, {
      timeline_start: at + shift,
      timeline_end: at + shift + 0.4,
    });
  const before = [
    scriptUtterance("host", "Maya", [
      word("a", 0, 10, 0),
      word("b", 1, 10.5, 0),
      word("a", 2, 11, 0),
      word("a", 3, 11.5, 0),
    ]),
  ];
  // "b" is cut and the line ripples up by half a second after it.
  const after = [
    scriptUtterance(
      "host",
      "Maya",
      [word("a", 0, 10, 0), word("a", 1, 11, -0.5), word("a", 2, 11.5, -0.5)],
      { start: 10 },
    ),
  ];

  it("follows the third word, not the fourth that now sits in its place", () => {
    seedScript({
      projectPath: "share:abc",
      guestMode: "comment",
      shareCapabilities: COMMENTER_CAPABILITIES,
      utterances: before,
      project: { clips: TWO_LANE_CLIPS },
    });
    const memory = { grant: GRANT, utterances: before };
    const rerender = mount(live(before));
    drag(2, 2);
    expect(stored()).toMatchObject({ startWordIndex: 2, endWordIndex: 2 });
    rerender(
      shownTranscriptOf(
        { utterances: headers(after) } as never,
        memory,
        GRANT,
        false,
      ),
    );
    expect(stored()).toMatchObject({ startWordIndex: 2, endWordIndex: 2 });
    rerender(live(after));
    expect(stored()).toMatchObject({ startWordIndex: 1, endWordIndex: 1 });
  });
});

describe("one recording placed twice on the timeline", () => {
  const place = (shift: number) =>
    scriptUtterance("host", "Maya", [
      scriptWord("yes", 0, 5, {
        timeline_start: 5 + shift,
        timeline_end: 5.4 + shift,
      }),
      scriptWord("no", 1, 6, {
        timeline_start: 6 + shift,
        timeline_end: 6.4 + shift,
      }),
    ]);
  const twice = (a: number, b: number) => [place(a), place(b)];

  it("keeps a pick on the second copy through a refresh and clears it when a cut shifts both", () => {
    seedScript({
      projectPath: "share:abc",
      guestMode: "comment",
      shareCapabilities: COMMENTER_CAPABILITIES,
      utterances: twice(0, 30),
      project: { clips: TWO_LANE_CLIPS },
    });
    const rerender = mount(live(twice(0, 30)));
    drag(2, 3);
    const picked = stored();
    expect(picked).toMatchObject({ kind: "transcriptRange" });
    // Nothing changed for the words: a refresh of the same rows keeps the pick.
    rerender(live(twice(0, 30)));
    expect(stored()).toBe(picked);
    // A cut elsewhere moves both copies on the timeline: which was picked is lost.
    rerender(live(twice(-5, 25)));
    expect(stored()).toBeNull();
  });
});

describe("a selection over a line that is still held", () => {
  const w = (text: string, n: number, at: number) => scriptWord(text, n, at);
  const row = (words: ReturnType<typeof scriptWord>[]) =>
    scriptUtterance("host", "Maya", words);
  const before = [
    row([w("x", 0, 10), w("p", 1, 11), w("q", 2, 12)]),
    row([w("m", 3, 14), w("n", 4, 15)]),
    row([w("r", 5, 20), w("s", 6, 21)]),
  ];

  it("moves its live ends once their words are live and says nothing, though a held line lies between", () => {
    seedScript({
      projectPath: "share:abc",
      guestMode: "comment",
      shareCapabilities: COMMENTER_CAPABILITIES,
      utterances: before,
      project: { clips: TWO_LANE_CLIPS },
    });
    const rerender = mount(live(before));
    drag(1, 6);
    expect(stored()).toMatchObject({ startWordIndex: 1, endWordIndex: 6 });
    useDawStore.setState({ feedbackToast: null });
    const say = vi.spyOn(useDawStore.getState(), "announceStatus");
    // "x" is cut. The ends' lines are live again; the line between is not.
    const first = row([w("p", 0, 11), w("q", 1, 12)]);
    const last = row([w("r", 4, 20), w("s", 5, 21)]);
    const middle = headers([before[1]!])[0]!;
    rerender(
      shownTranscriptOf(
        { utterances: [first, middle, last] } as never,
        { grant: GRANT, utterances: before },
        GRANT,
        false,
      ),
    );
    expect(say).not.toHaveBeenCalled();
    expect(useDawStore.getState().feedbackToast).toBeNull();
    expect(stored()).toMatchObject({ startWordIndex: 0, endWordIndex: 5 });
  });
});

describe("a gesture that the store did not take", () => {
  it("does not hand an older selection to this gesture's words", () => {
    const rows = scriptUtterances();
    seedScript({
      projectPath: "share:abc",
      guestMode: "comment",
      shareCapabilities: COMMENTER_CAPABILITIES,
      utterances: rows,
      project: { clips: TWO_LANE_CLIPS },
    });
    const rerender = mount(live(rows));
    const mine = {
      kind: "transcriptRange",
      trackId: "host",
      sourceId: null,
      startWordIndex: 0,
      endWordIndex: 1,
    } as const;
    // Words across two tracks need a project to become a range; with none the
    // store takes nothing and keeps the selection it had.
    useDawStore.setState({ selection: mine, project: null });
    drag(3, 7);
    expect(stored()).toBe(mine);
    rerender(live(rows.filter((row) => row.track_id === "host")));
    expect(stored()).toBe(mine);
  });
});

describe("a selection when the Script goes away mid-refresh", () => {
  it("is cleared when the Script unmounts while refreshing, kept when it is not", () => {
    const cut = lines(
      ["Welcome", "to", "the", "show", "friends"],
      SPOKEN[1]!,
      -0.5,
    );
    const first = mount(live(COMPLETE));
    drag(6, 8);
    first(refreshing(cut));
    first.unmount();
    expect(stored()).toBeNull();
    const second = mount(live(COMPLETE));
    drag(6, 8);
    second.unmount();
    expect(stored()).not.toBeNull();
  });
});

describe("a gesture on a word that is still refreshing", () => {
  it("announces a tap once", () => {
    const cut = lines(SPOKEN[0]!, SPOKEN[1]!, 1);
    mount(refreshing(cut));
    const say = vi.spyOn(useDawStore.getState(), "announceStatus");
    fireEvent.click(document.querySelector('[data-stop="7"]') as Element);
    expect(say).toHaveBeenCalledTimes(1);
  });

  it("says so for a tap and for a dropped selection", () => {
    const cut = lines(SPOKEN[0]!, SPOKEN[1]!, 1);
    mount(refreshing(cut));
    fireEvent.click(document.querySelector('[data-stop="7"]') as Element);
    const toast = useDawStore.getState().feedbackToast;
    expect(toast?.message).toBe(TRANSCRIPT_REFRESHING);
    expect(toast?.tone).toBe("error");
    useDawStore.setState({ feedbackToast: null });
    // A second gesture, later than the first.
    const now = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(now + 5_000);
    drag(6, 8);
    expect(useDawStore.getState().feedbackToast?.message).toBe(
      TRANSCRIPT_REFRESHING,
    );
    expect(stored()).toBeNull();
  });
});

describe("a selection across two speakers, which the store keeps as a timeline range", () => {
  const shift = (rows: CombinedUtterance[], by: number) =>
    rows.map((row) => ({
      ...row,
      timeline_start: (row.timeline_start ?? 0) + by,
      timeline_end: (row.timeline_end ?? 0) + by,
      words: row.words?.map((w) => ({
        ...w,
        timeline_start: (w.timeline_start ?? 0) + by,
        timeline_end: (w.timeline_end ?? 0) + by,
      })),
    }));
  const spoken = scriptUtterances().filter((row) => !row.suppressed_only);
  // The host's first word is cut and everything after it moves 0.5 s earlier.
  const cut = shift(spoken, -0.5).map((row, at) =>
    at === 0
      ? {
          ...row,
          words: row.words
            ?.slice(1)
            .map((w) => ({ ...w, word_index: (w.word_index ?? 0) - 1 })),
        }
      : row,
  );
  const inProject = (rows: CombinedUtterance[], complete: boolean) =>
    useDawStore.setState((s) => ({
      project: {
        ...s.project!,
        transcript: {
          utterances: complete ? rows : headers(rows),
        },
        meta: {
          ...s.project!.meta,
          hydration: { transcript_words: complete },
        },
      },
    }));
  const asSettled = { grant: GRANT, utterances: spoken };

  it("is refused with the reason, never the playhead, while its words refresh, then takes the new times", () => {
    const rerender = mount(live(spoken));
    drag(2, 7);
    const before = stored();
    expect(before?.kind).toBe("range");
    if (before?.kind !== "range") throw new Error("expected a range");
    useDawStore.setState({ playheadSec: 3 });

    inProject(cut, false);
    rerender(
      shownTranscriptOf(
        { utterances: headers(cut) } as never,
        asSettled,
        GRANT,
        false,
      ),
    );
    const state = useDawStore.getState();
    expect(resolveCommentAnchor(state)).toEqual({
      source: "refreshing",
      reason: TRANSCRIPT_REFRESHING,
    });
    expect(
      resolveSelectionRange(state.project!, state.selection),
    ).toMatchObject({ targets: [expect.anything()] });
    expect(
      resolveSelectionRange(state.project!, state.selection, state.projectPath),
    ).toMatchObject({ targets: [], refreshing: true });

    inProject(cut, true);
    rerender(live(cut));
    const after = stored();
    expect(after?.kind).toBe("range");
    if (after?.kind !== "range") throw new Error("expected a range");
    expect(after.target.intervals[0]!.start).toBe(
      before.target.intervals[0]!.start - 0.5,
    );
    expect(resolveCommentAnchor(useDawStore.getState())).toMatchObject({
      source: "selection",
    });
  });
});
