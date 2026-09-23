import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { scrollChildIntoParent } from "../utils/transcript";
import { TranscriptPanel } from "./TranscriptPanel";

vi.mock("../utils/transcript", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/transcript")>();
  return {
    ...actual,
    scrollChildIntoParent: vi.fn(actual.scrollChildIntoParent),
  };
});

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));

vi.mock("../inspector/views/TranscriptWordInspector", () => ({
  TranscriptWordInspector: ({
    trackId,
    wordIndex,
    embedded,
  }: {
    trackId: string;
    wordIndex: number;
    embedded?: boolean;
  }) => (
    <div data-testid="docked-word-editor">
      {embedded ? "embedded" : "rail"} {trackId}:{wordIndex}
    </div>
  ),
}));

function project() {
  return minimalProject({
    timeline_duration_sec: 10,
    transcript: {
      utterances: [
        {
          track_id: "host",
          speaker: "Host",
          start: 0,
          end: 2,
          text: "hello there",
          mappable: true,
          timeline_start: 0,
          timeline_end: 2,
          words: [
            {
              text: "hello",
              start: 0,
              end: 1,
              timeline_start: 0,
              timeline_end: 1,
              word_index: 0,
              confidence: 0.9,
            },
            {
              text: "there",
              start: 1,
              end: 2,
              timeline_start: 1,
              timeline_end: 2,
              word_index: 1,
              confidence: 0.9,
            },
          ],
        },
      ],
    },
  });
}

function largeProject(turnCount = 1200) {
  const base = project();
  return {
    ...base,
    timeline_duration_sec: turnCount * 2,
    transcript: {
      utterances: Array.from({ length: turnCount }, (_, index) => ({
        track_id: "host",
        speaker: `Speaker ${index}`,
        start: index * 2,
        end: index * 2 + 1,
        text: `turn ${index}`,
        mappable: true,
        timeline_start: index * 2,
        timeline_end: index * 2 + 1,
        words: [
          {
            text: `turn ${index}`,
            start: index * 2,
            end: index * 2 + 1,
            timeline_start: index * 2,
            timeline_end: index * 2 + 1,
            word_index: index,
            confidence: 0.9,
          },
        ],
      })),
    },
  };
}

describe("TranscriptPanel", () => {
  beforeEach(() => {
    useDawStore.setState({
      project: project(),
      projectPath: "/tmp/ep",
      playheadSec: 0,
      selection: null,
      transcriptFollowPlayhead: false,
      focusMode: "default",
    });
  });

  it("labels Correct instead of Edit", async () => {
    const { container } = render(<TranscriptPanel />);
    expect(
      within(container).getByRole("button", { name: /Correct/i }),
    ).toBeTruthy();
    expect(
      within(container).queryByRole("button", { name: /^Edit$/i }),
    ).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("uses the loading string as Correct aria-label while words are not hydrated", () => {
    const base = project();
    useDawStore.setState({
      project: {
        ...base,
        meta: {
          ...base.meta,
          hydration: { transcript_words: false, history_groups: false },
        },
      },
    });
    const { container } = render(<TranscriptPanel />);
    expect(
      within(container).getByRole("button", {
        name: "Loading transcript words…",
      }),
    ).toBeDisabled();
  });

  it("docks word editor in text focus when Correct selects a word", () => {
    useDawStore.setState({ focusMode: "text" });
    const { container } = render(<TranscriptPanel />);
    fireEvent.click(
      within(container).getByRole("button", { name: /Correct/i }),
    );
    fireEvent.click(within(container).getByRole("button", { name: "hello" }));
    expect(
      within(container).getByTestId("docked-word-editor").textContent,
    ).toContain("embedded host:0");
  });

  it("Select mode builds a transcript range", () => {
    const { container } = render(<TranscriptPanel />);
    fireEvent.click(within(container).getByRole("button", { name: /Select/i }));
    fireEvent.click(within(container).getByRole("button", { name: "hello" }));
    fireEvent.click(within(container).getByRole("button", { name: "there" }), {
      shiftKey: true,
    });
    const sel = useDawStore.getState().selection;
    expect(sel?.kind).toBe("transcriptRange");
    if (sel?.kind === "transcriptRange") {
      expect(sel.startWordIndex).toBe(0);
      expect(sel.endWordIndex).toBe(1);
    }
  });

  it("Select mode shift-click extends after mousedown without resetting anchor", () => {
    const { container } = render(<TranscriptPanel />);
    fireEvent.click(within(container).getByRole("button", { name: /Select/i }));
    const hello = within(container).getByRole("button", { name: "hello" });
    const there = within(container).getByRole("button", { name: "there" });
    // Real browsers fire mousedown before click; shift must not reset the anchor.
    fireEvent.mouseDown(hello, { button: 0 });
    fireEvent.click(hello);
    fireEvent.mouseDown(there, { button: 0, shiftKey: true });
    fireEvent.click(there, { shiftKey: true });
    const sel = useDawStore.getState().selection;
    expect(sel?.kind).toBe("transcriptRange");
    if (sel?.kind === "transcriptRange") {
      expect(sel.startWordIndex).toBe(0);
      expect(sel.endWordIndex).toBe(1);
    }
  });

  it("Select mode drag keeps the extended range after mouseup click", () => {
    const { container } = render(<TranscriptPanel />);
    fireEvent.click(within(container).getByRole("button", { name: /Select/i }));
    const hello = within(container).getByRole("button", { name: "hello" });
    const there = within(container).getByRole("button", { name: "there" });
    fireEvent.mouseDown(hello, { button: 0 });
    fireEvent.mouseEnter(there);
    // Global mouseup clears draggingRef before click (browser order).
    fireEvent.mouseUp(document);
    fireEvent.click(there);
    const sel = useDawStore.getState().selection;
    expect(sel?.kind).toBe("transcriptRange");
    if (sel?.kind === "transcriptRange") {
      expect(sel.startWordIndex).toBe(0);
      expect(sel.endWordIndex).toBe(1);
    }
  });

  it("Annotate shows an edit-boundary mark for every join on transcript tracks", () => {
    useDawStore.setState({
      project: minimalProject({
        timeline_duration_sec: 30,
        clips: {
          clip_count: 3,
          tracks: {
            host: [
              {
                id: "c1",
                track_id: "host",
                source_start: 0,
                source_end: 5,
                timeline_start: 0,
                timeline_end: 5,
                fade_in_ms: 0,
                fade_out_ms: 0,
                join_in_mode: "fade",
                source_id: null,
              },
              {
                id: "c2",
                track_id: "host",
                source_start: 8,
                source_end: 12,
                timeline_start: 5,
                timeline_end: 9,
                fade_in_ms: 0,
                fade_out_ms: 0,
                join_in_mode: "fade",
                source_id: null,
              },
              {
                id: "c3",
                track_id: "host",
                source_start: 20,
                source_end: 25,
                timeline_start: 9,
                timeline_end: 14,
                fade_in_ms: 0,
                fade_out_ms: 0,
                join_in_mode: "fade",
                source_id: null,
              },
            ],
          },
        },
        edit_boundaries: [
          {
            id: "eb:c1:c2",
            track_id: "host",
            left_clip_id: "c1",
            right_clip_id: "c2",
            timeline_join_sec: 5,
            cutaway_source_start: 5,
            cutaway_source_end: 8,
            has_cutaway: true,
            cutaway_word_ids: [],
          },
          {
            id: "eb:c2:c3",
            track_id: "host",
            left_clip_id: "c2",
            right_clip_id: "c3",
            // Join far from any turn *end* — old ±0.2s filter would drop this.
            timeline_join_sec: 9,
            cutaway_source_start: 12,
            cutaway_source_end: 20,
            has_cutaway: true,
            cutaway_word_ids: [],
          },
        ],
        transcript: {
          utterances: [
            {
              track_id: "host",
              speaker: "Host",
              start: 0,
              end: 14,
              text: "alpha bravo charlie",
              mappable: true,
              timeline_start: 0,
              timeline_end: 14,
              words: [
                {
                  text: "alpha",
                  start: 0,
                  end: 4,
                  timeline_start: 0,
                  timeline_end: 4,
                  word_index: 0,
                  confidence: 0.9,
                },
                {
                  text: "bravo",
                  start: 4,
                  end: 8,
                  timeline_start: 4,
                  timeline_end: 8,
                  word_index: 1,
                  confidence: 0.9,
                },
                {
                  text: "charlie",
                  start: 8,
                  end: 14,
                  timeline_start: 8,
                  timeline_end: 14,
                  word_index: 2,
                  confidence: 0.9,
                },
              ],
            },
          ],
        },
      }),
      transcriptAnnotate: false,
    });
    const { container } = render(<TranscriptPanel />);
    expect(container.querySelectorAll(".edit-boundary-mark")).toHaveLength(0);
    fireEvent.click(
      within(container).getByRole("button", { name: /Annotate/i }),
    );
    const marks = container.querySelectorAll(".edit-boundary-mark");
    expect(marks).toHaveLength(2);
    expect(
      [...marks]
        .map((m) => m.getAttribute("data-boundary-id"))
        .sort((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual(["eb:c1:c2", "eb:c2:c3"]);
  });

  it("anchors turns and words for presence", () => {
    const { container } = render(<TranscriptPanel />);
    expect(
      container.querySelector('[data-presence-anchor="transcript:turn:0"]'),
    ).toBeTruthy();
    expect(
      container.querySelector(
        '[data-presence-anchor="transcript:word:host:0"]',
      ),
    ).toBeTruthy();
  });

  it("scrolls to a follow request without unlocking playhead follow", () => {
    useDawStore.setState({ transcriptFollowPlayhead: true });
    render(<TranscriptPanel />);
    act(() => {
      useDawStore.getState().setTranscriptScrollRequest("transcript:turn:0");
    });
    expect(useDawStore.getState().transcriptFollowPlayhead).toBe(true);
    expect(useDawStore.getState().transcriptScrollRequest).toBeNull();
  });

  it("unfollows on manual transcript scroll", () => {
    useDawStore.setState({ followingClientId: "a" });
    const { container } = render(<TranscriptPanel />);
    const list = container.querySelector(".transcript-list");
    expect(list).toBeTruthy();
    fireEvent.wheel(list!);
    fireEvent.scroll(list!);
    expect(useDawStore.getState().followingClientId).toBeNull();
  });

  it("ignores scroll events without user input (programmatic writes)", () => {
    useDawStore.setState({
      followingClientId: "a",
      transcriptFollowPlayhead: true,
    });
    const { container } = render(<TranscriptPanel />);
    const list = container.querySelector(".transcript-list")!;
    fireEvent.scroll(list);
    // Clicking a child (e.g. a word) is not scroll intent either.
    fireEvent.pointerDown(
      within(container).getByRole("button", { name: "hello" }),
    );
    fireEvent.scroll(list);
    expect(useDawStore.getState().transcriptFollowPlayhead).toBe(true);
    expect(useDawStore.getState().followingClientId).toBe("a");
    fireEvent.keyDown(list, { key: "PageDown" });
    fireEvent.scroll(list);
    expect(useDawStore.getState().transcriptFollowPlayhead).toBe(false);
    expect(useDawStore.getState().followingClientId).toBeNull();
  });
});

describe("TranscriptPanel virtualization", () => {
  let scrollTopWrites: number[];

  beforeEach(() => {
    scrollTopWrites = [];
    let scrollTop = 0;
    // virtual-core reads offset*/client* sizes; list = 600px, turns = 96px.
    const size = (listPx: number, turnPx: number) =>
      function (this: HTMLElement) {
        return this.classList.contains("transcript-list") ? listPx : turnPx;
      };
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      size(600, 96),
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      size(600, 96),
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      1200 * 96,
    );
    // Turns sit at their translateY offset, shifted by the list's scrollTop.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains("transcript-list")) {
          return DOMRect.fromRect({ width: 800, height: 600 });
        }
        const turn = this.closest<HTMLElement>(".utterance-turn");
        const y = Number(
          /translateY\(([-\d.]+)px\)/.exec(turn?.style.transform ?? "")?.[1] ??
            0,
        );
        return DOMRect.fromRect({ y: y - scrollTop, width: 800, height: 96 });
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(
      () => scrollTop,
    );
    vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(
      function (this: HTMLElement, v: number) {
        scrollTop = v;
        scrollTopWrites.push(v);
        // Browsers fire scroll after a programmatic write (no user input).
        this.dispatchEvent(new Event("scroll"));
      },
    );
    vi.mocked(scrollChildIntoParent).mockClear();
    useDawStore.setState({
      project: largeProject(),
      projectPath: "/tmp/ep",
      playheadSec: 0.5,
      selection: null,
      transcriptFollowPlayhead: false,
      transcriptScrollRequest: null,
      followingClientId: null,
      focusMode: "default",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const turnEl = (container: HTMLElement, index: number) =>
    container.querySelector<HTMLElement>(`[data-turn-index="${index}"]`);
  const lastScrolledTurn = () => {
    const el = vi.mocked(scrollChildIntoParent).mock.lastCall?.[1];
    return el?.closest("[data-turn-index]")?.getAttribute("data-turn-index");
  };

  it("renders a bounded, labelled list of turns", async () => {
    const { container } = render(<TranscriptPanel />);
    const turns = container.querySelectorAll(".utterance-turn");
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.length).toBeLessThan(1200);
    expect(turnEl(container, 0)).toBeTruthy();
    expect(turnEl(container, 1199)).toBeNull();
    const list = container.querySelector(".transcript-list.is-virtualized");
    expect(list?.getAttribute("role")).toBe("list");
    expect(turnEl(container, 0)?.getAttribute("aria-setsize")).toBe("1200");
    expect(turnEl(container, 0)?.getAttribute("aria-posinset")).toBe("1");
    await expectNoA11yViolations(container);
  });

  it("mounts an offscreen request target, scrolls to it, and clears it", () => {
    const { container } = render(<TranscriptPanel />);
    act(() => {
      useDawStore.getState().setTranscriptScrollRequest("transcript:turn:1199");
    });
    expect(useDawStore.getState().transcriptScrollRequest).toBeNull();
    expect(lastScrolledTurn()).toBe("1199");
    expect(vi.mocked(scrollChildIntoParent).mock.lastCall?.[2]).toBe(0.2);
    expect(turnEl(container, 1199)).toBeTruthy();
    expect(scrollTopWrites.at(-1)).toBeGreaterThan(100_000);
  });

  it("clears an unresolvable request instead of retrying", () => {
    render(<TranscriptPanel />);
    act(() => {
      useDawStore
        .getState()
        .setTranscriptScrollRequest("transcript:word:nobody:424242");
    });
    expect(useDawStore.getState().transcriptScrollRequest).toBeNull();
    expect(vi.mocked(scrollChildIntoParent)).not.toHaveBeenCalled();
  });

  it("follows an offscreen active turn without unlocking follow", () => {
    useDawStore.setState({ transcriptFollowPlayhead: true });
    const { container } = render(<TranscriptPanel />);
    act(() => {
      useDawStore.getState().setPlayheadSec(1199 * 2 + 0.5);
    });
    expect(turnEl(container, 1199)).toBeTruthy();
    expect(lastScrolledTurn()).toBe("1199");
    expect(scrollTopWrites.at(-1)).toBeGreaterThan(100_000);
    // Re-measure / range scrolls arrive without user input.
    fireEvent.scroll(container.querySelector(".transcript-list")!);
    expect(useDawStore.getState().transcriptFollowPlayhead).toBe(true);
  });

  it("unlocks follow on a manual wheel scroll", () => {
    useDawStore.setState({ transcriptFollowPlayhead: true });
    const { container } = render(<TranscriptPanel />);
    const list = container.querySelector(".transcript-list")!;
    fireEvent.wheel(list);
    fireEvent.scroll(list);
    expect(useDawStore.getState().transcriptFollowPlayhead).toBe(false);
  });

  it("lets a paused follower keep the leader's jump until the playhead moves", () => {
    useDawStore.setState({ transcriptFollowPlayhead: true });
    const { container } = render(<TranscriptPanel />);
    act(() => {
      useDawStore.getState().setTranscriptScrollRequest("transcript:turn:900");
    });
    expect(lastScrolledTurn()).toBe("900");
    expect(turnEl(container, 900)).toBeTruthy();
    vi.mocked(scrollChildIntoParent).mockClear();
    // Re-run follow (new project identity, same playhead): must not snap back.
    act(() => {
      useDawStore.setState({ project: largeProject() });
    });
    expect(vi.mocked(scrollChildIntoParent)).not.toHaveBeenCalled();
    act(() => {
      useDawStore.getState().setPlayheadSec(2.5);
    });
    expect(lastScrolledTurn()).toBe("1");
    expect(vi.mocked(scrollChildIntoParent).mock.lastCall?.[2]).toBe(0.5);
  });

  it("keeps the selected and focused turns mounted when scrolled away", () => {
    const { container } = render(<TranscriptPanel />);
    fireEvent.click(
      within(container).getByRole("button", { name: /Correct/i }),
    );
    act(() => {
      useDawStore.setState({
        selection: { kind: "transcriptWord", trackId: "host", wordIndex: 1100 },
      });
    });
    expect(turnEl(container, 1100)).toBeTruthy();
    const word = within(turnEl(container, 0)!).getByRole("button", {
      name: "turn 0",
    });
    fireEvent.focus(word);
    act(() => {
      useDawStore.getState().setTranscriptScrollRequest("transcript:turn:1199");
    });
    expect(turnEl(container, 0)).toBeTruthy();
  });
});
