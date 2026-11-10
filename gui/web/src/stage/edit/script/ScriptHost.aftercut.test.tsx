import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitDocumentCommand } from "../../../api/documentEdits";
import { clearRegisteredCommands } from "../../../commands/execute";
import { registerDawCommands } from "../../../commands/register";
import { FeedbackToast } from "../../../feedback/FeedbackToast";
import { useDawKeymapListener } from "../../../keymap/listener";
import { useDawStore } from "../../../state/dawStore";
import { resetFeedbackRepeatForTests } from "../../../state/uiSlice";
import { COMMENTER_CAPABILITIES, clipRow } from "../../../test/fixtures";
import {
  scriptUtterance,
  scriptWord,
  seedScript,
} from "../../../test/scriptHostKit";
import type { HistoryEntryId } from "../../../types/project";
import { closeOverlay, noteMenuOpen, openOverlay } from "../../../ui/modalGate";
import { registerAfterCutNav } from "./afterCutNav";
import { resetQueuedCutsForTests } from "./cutHits";
import { registerCutToast } from "./cutToast";
import { ScriptHost } from "./ScriptHost";

vi.mock("../../../api/documentEdits", async (orig) => ({
  ...(await orig<typeof import("../../../api/documentEdits")>()),
  submitDocumentCommand: vi.fn(),
}));
vi.mock("../../../commands/seek", () => ({ seekTransport: vi.fn() }));

const head = (id: string) => id as HistoryEntryId;

const knows = () => [
  scriptUtterance("host", "Maya", [
    scriptWord("you", 0, 10),
    scriptWord("know", 1, 10.5),
    scriptWord("so", 2, 11),
    scriptWord("you", 3, 12),
    scriptWord("know", 4, 12.5),
    scriptWord("and", 5, 13),
    scriptWord("you", 6, 14),
    scriptWord("know", 7, 14.5),
  ]),
];

const clips = () => ({
  clip_count: 1,
  tracks: {
    host: [
      clipRow({
        id: "host-clip",
        track_id: "host",
        source_end: 200,
        timeline_end: 200,
      }),
    ],
  },
});

function Harness() {
  useDawKeymapListener();
  return (
    <>
      <ScriptHost />
      <FeedbackToast />
    </>
  );
}

const state = () => useDawStore.getState();
const range = (start: number, end: number) => ({
  kind: "transcriptRange" as const,
  trackId: "host",
  sourceId: null,
  startWordIndex: start,
  endWordIndex: end,
});
const selected = () => {
  const s = state().selection;
  return s?.kind === "transcriptRange"
    ? [s.startWordIndex, s.endWordIndex]
    : null;
};

function cutAway(upTo: readonly number[], newHead: string) {
  const { project } = state();
  useDawStore.setState({
    project: {
      ...project!,
      history: { ...project!.history!, head_id: head(newHead) },
      transcript: {
        utterances: project!.transcript!.utterances.map((u) => ({
          ...u,
          words: u.words!.map((w) =>
            upTo.includes(w.word_index!)
              ? {
                  ...w,
                  mappable: false,
                  timeline_start: null,
                  timeline_end: null,
                }
              : w,
          ),
        })),
      },
    },
  });
}

async function startCut(start = 0, end = 1) {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(
    await screen
      .findByRole("button", { name: "you", hidden: true })
      .catch(() => screen.getAllByRole("button", { name: "you" })[0]),
  );
  act(() => state().setSelection(range(start, end)));
  await user.keyboard("{Backspace}");
  await waitFor(() => expect(state().afterCut).not.toBeNull());
  return user;
}

function tab(init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  return event;
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

beforeEach(() => {
  stubObserver();
  vi.resetAllMocks();
  clearRegisteredCommands();
  registerDawCommands();
  registerCutToast();
  registerAfterCutNav();
  resetQueuedCutsForTests();
  resetFeedbackRepeatForTests();
  seedScript({ utterances: knows(), project: { clips: clips() } });
  useDawStore.setState({
    stage: "edit",
    projectEpoch: 1,
    rangeBusy: false,
    feedbackToast: null,
    afterCut: null,
    scriptCollapsed: false,
    editSurface: "text",
  });
  let cuts = 0;
  vi.mocked(submitDocumentCommand).mockImplementation(async () => ({
    type: "Applied",
    history_head_id: head(`h${++cuts}`),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Tab after a words cut", () => {
  it("steps through the other occurrences and ends when none are left", async () => {
    const user = await startCut();
    expect(state().feedbackToast?.message).toContain("2 more");
    cutAway([0, 1], "h1");
    expect(tab().defaultPrevented).toBe(true);
    expect(selected()).toEqual([3, 4]);
    expect(state().statusAnnouncement).toBe('"you know", 1 of 2');
    await waitFor(() =>
      expect(document.activeElement).toHaveTextContent("you"),
    );
    expect(document.activeElement?.closest(".sys-script-body")).not.toBeNull();
    await user.keyboard("{Backspace}");
    await waitFor(() => expect(submitDocumentCommand).toHaveBeenCalledTimes(2));
    cutAway([0, 1, 3, 4], "h2");
    expect(tab().defaultPrevented).toBe(true);
    expect(selected()).toEqual([6, 7]);
    await user.keyboard("{Backspace}");
    await waitFor(() => expect(submitDocumentCommand).toHaveBeenCalledTimes(3));
    cutAway([0, 1, 3, 4, 6, 7], "h3");
    expect(tab().defaultPrevented).toBe(false);
  });

  it("does not select the words just cut before the project absorbs the cut", async () => {
    await startCut();
    tab();
    expect(selected()).toEqual([3, 4]);
  });

  it("goes back with Shift+Tab and wraps past the first", async () => {
    await startCut(3, 4);
    cutAway([3, 4], "h1");
    expect(tab({ shiftKey: true }).defaultPrevented).toBe(true);
    expect(selected()).toEqual([0, 1]);
    expect(tab({ shiftKey: true }).defaultPrevented).toBe(true);
    expect(selected()).toEqual([6, 7]);
  });

  it("lets Tab leave once it would come back to where it started", async () => {
    await startCut();
    cutAway([0, 1], "h1");
    expect(tab().defaultPrevented).toBe(true);
    expect(tab().defaultPrevented).toBe(true);
    expect(selected()).toEqual([6, 7]);
    expect(tab().defaultPrevented).toBe(false);
    expect(selected()).toEqual([6, 7]);
    expect(tab({ shiftKey: true }).defaultPrevented).toBe(true);
    expect(selected()).toEqual([3, 4]);
  });

  describe("ends", () => {
    it.each([
      ["undo", () => cutAway([], "h0")],
      ["another edit", () => cutAway([2], "h9")],
      [
        "an undo back to the head before the cut",
        () => {
          const { project } = state();
          useDawStore.setState({
            project: {
              ...project!,
              history: {
                ...project!.history!,
                head_id: head("root"),
                can_redo: true,
              },
            },
          });
        },
      ],
      [
        "a click on a word",
        async () => {
          await userEvent.click(
            screen.getAllByRole("button", { name: "and" })[0],
          );
        },
      ],
      [
        "a changed selection",
        () => act(() => state().setSelection(range(2, 2))),
      ],
      ["a new project epoch", () => useDawStore.setState({ projectEpoch: 2 })],
      ["leaving Edit", () => useDawStore.setState({ stage: "mix" as never })],
    ])("%s", async (_name, end) => {
      await startCut();
      cutAway([0, 1], "h1");
      await end();
      await act(async () => {});
      document.querySelector<HTMLElement>(".sys-script-word")?.focus();
      expect(tab().defaultPrevented).toBe(false);
    });

    it.each([
      ["Escape", "{Escape}"],
      ["a letter", "x"],
    ])("%s", async (_name, keys) => {
      const user = await startCut();
      cutAway([0, 1], "h1");
      await user.keyboard(keys);
      expect(state().afterCut).toBeNull();
      expect(tab().defaultPrevented).toBe(false);
    });

    it("keeps the chain across a bare Shift press", async () => {
      const user = await startCut();
      cutAway([0, 1], "h1");
      await user.keyboard("{Shift>}");
      expect(state().afterCut).not.toBeNull();
      await user.keyboard("{/Shift}");
    });
  });

  it("keeps Tab native on a toast button or the Find button", async () => {
    await startCut();
    cutAway([0, 1], "h1");
    screen.getByRole("button", { name: "Find in transcript" }).focus();
    expect(tab().defaultPrevented).toBe(false);
    screen.getByRole("button", { name: "Cut all" }).focus();
    expect(tab().defaultPrevented).toBe(false);
    expect(selected()).toBeNull();
  });

  it("keeps focus in the Script body after the cut", async () => {
    await startCut();
    cutAway([0, 1], "h1");
    await waitFor(() =>
      expect(
        document.activeElement?.closest(".sys-script-body"),
      ).not.toBeNull(),
    );
    expect(tab().defaultPrevented).toBe(true);
  });

  it("keeps focus in the Script body after a cut of a Tab-selected occurrence", async () => {
    const user = await startCut();
    cutAway([0, 1], "h1");
    await waitFor(() =>
      expect(
        document.activeElement?.closest(".sys-script-body"),
      ).not.toBeNull(),
    );
    expect(tab().defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(document.activeElement).toHaveTextContent("you"),
    );
    const stale = document.querySelector<HTMLElement>(
      ".sys-script-body .sys-seam-hit, .sys-script-body button:not(.sys-script-word)",
    );
    expect(stale).not.toBeNull();
    stale!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await act(async () => {});
    await user.keyboard("{Backspace}");
    await waitFor(() => expect(submitDocumentCommand).toHaveBeenCalledTimes(2));
    const { project } = state();
    useDawStore.setState({
      project: {
        ...project!,
        history: { ...project!.history!, head_id: head("h2") },
        transcript: {
          utterances: project!.transcript!.utterances.map((u) => ({
            ...u,
            words: u.words!.filter(
              (w) => ![0, 1, 3, 4].includes(w.word_index!),
            ),
          })),
        },
      },
    });
    await act(async () => {});
    await waitFor(() =>
      expect(
        document.activeElement?.closest(".sys-script-body"),
      ).not.toBeNull(),
    );
    expect(tab().defaultPrevented).toBe(true);
    expect(selected()).toEqual([6, 7]);
  });

  it("is left native while a menu holds the keyboard", async () => {
    await startCut();
    cutAway([0, 1], "h1");
    await waitFor(() =>
      expect(
        document.activeElement?.closest(".sys-script-body"),
      ).not.toBeNull(),
    );
    act(() => noteMenuOpen(true));
    try {
      expect(tab().defaultPrevented).toBe(false);
      expect(state().afterCut).not.toBeNull();
    } finally {
      act(() => noteMenuOpen(false));
    }
    expect(tab().defaultPrevented).toBe(true);
  });

  it("is left native while a modal holds the keyboard", async () => {
    await startCut();
    cutAway([0, 1], "h1");
    await waitFor(() =>
      expect(
        document.activeElement?.closest(".sys-script-body"),
      ).not.toBeNull(),
    );
    const layer = openOverlay(true);
    try {
      expect(tab().defaultPrevented).toBe(false);
      expect(state().afterCut).not.toBeNull();
    } finally {
      closeOverlay(layer);
    }
    expect(tab().defaultPrevented).toBe(true);
  });

  it("is left native on a button in the Script that is not a word", async () => {
    await startCut();
    cutAway([0, 1], "h1");
    const other = document.createElement("button");
    document.querySelector(".sys-script-body")!.append(other);
    other.focus();
    expect(tab().defaultPrevented).toBe(false);
    expect(selected()).toBeNull();
    other.remove();
  });

  it("carries earlier cuts across a chain so Tab never comes back to them", async () => {
    const user = await startCut();
    expect(tab().defaultPrevented).toBe(true);
    expect(selected()).toEqual([3, 4]);
    await user.keyboard("{Backspace}");
    await waitFor(() => expect(submitDocumentCommand).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(selected()).toBeNull());
    expect(tab().defaultPrevented).toBe(true);
    expect(selected()).toEqual([6, 7]);
    expect(tab().defaultPrevented).toBe(false);
    expect(selected()).toEqual([6, 7]);
  });

  it("does not move the selection while a later cut is in flight", async () => {
    const user = await startCut();
    expect(tab().defaultPrevented).toBe(true);
    let release: () => void = () => {};
    vi.mocked(submitDocumentCommand).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ type: "Applied", history_head_id: head("h2") });
        }),
    );
    await user.keyboard("{Backspace}");
    await waitFor(() => expect(state().rangeBusy).toBe(true));
    expect(tab().defaultPrevented).toBe(false);
    expect(selected()).toEqual([3, 4]);
    await act(async () => release());
  });

  it("keeps the chain through a toolbar Undo and Redo of the cut", async () => {
    await startCut();
    cutAway([0, 1], "h1");
    const { project } = state();
    useDawStore.setState({
      project: {
        ...project!,
        history: { ...project!.history!, head_id: head("h0") },
      },
    });
    expect(tab().defaultPrevented).toBe(false);
    useDawStore.setState({ project });
    expect(tab().defaultPrevented).toBe(true);
    expect(selected()).toEqual([3, 4]);
  });

  it("is never set for someone who may only suggest", async () => {
    useDawStore.setState({ shareCapabilities: COMMENTER_CAPABILITIES });
    useDawStore.setState({ projectPath: "share:tok", guestMode: "comment" });
    render(<Harness />);
    act(() => state().setSelection(range(0, 1)));
    fireEvent.keyDown(document.body, { key: "Backspace" });
    await act(async () => {});
    expect(state().afterCut).toBeNull();
  });

  it("is never set on the phone", async () => {
    useDawStore.setState({ shellBreakpoint: "phone" });
    render(<Harness />);
    act(() => state().setSelection(range(0, 1)));
    fireEvent.keyDown(document.body, { key: "Backspace" });
    await act(async () => {});
    expect(state().afterCut).toBeNull();
  });
});
