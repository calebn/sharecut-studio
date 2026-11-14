import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SettledTranscript,
  shownTranscriptOf,
} from "../../document/shownTranscript";
import { TRANSCRIPT_REFRESHING } from "../../edit/rangeSelection";
import { useDawStore } from "../../state/dawStore";
import { COMMENTER_CAPABILITIES } from "../../test/fixtures";
import { drag, layout } from "../../test/scriptDrag";
import {
  scriptUtterance,
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
  return (next: ReturnType<typeof live>) =>
    act(() => view.rerender(<GuestScriptHost shown={next} />));
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

describe("a gesture on a word that is still refreshing", () => {
  it("says so for a tap and for a dropped selection", () => {
    const cut = lines(SPOKEN[0]!, SPOKEN[1]!, 1);
    mount(refreshing(cut));
    fireEvent.click(document.querySelector('[data-stop="7"]') as Element);
    const toast = useDawStore.getState().feedbackToast;
    expect(toast?.message).toBe(TRANSCRIPT_REFRESHING);
    expect(toast?.tone).toBe("error");
    useDawStore.setState({ feedbackToast: null });
    drag(6, 8);
    expect(useDawStore.getState().feedbackToast?.message).toBe(
      TRANSCRIPT_REFRESHING,
    );
    expect(stored()).toBeNull();
  });
});
