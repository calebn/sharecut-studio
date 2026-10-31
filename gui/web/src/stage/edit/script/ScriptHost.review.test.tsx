import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../../state/dawStore";
import { sampleTrack } from "../../../test/fixtures";
import {
  scriptUtterance,
  scriptUtterances,
  scriptWord,
  seedScript,
} from "../../../test/scriptHostKit";
import type { EditBoundaryView } from "../../../types/project";
import { ScriptHost } from "./ScriptHost";
import { FIX_CUT_TEXT } from "./useScriptFixText";

const submitWordCorrection = vi.hoisted(() => vi.fn());
vi.mock("../../../transcript/wordCorrection", () => ({ submitWordCorrection }));
const seekTransport = vi.hoisted(() => vi.fn());
vi.mock("../../../commands/seek", () => ({ seekTransport }));
const moveLane = vi.hoisted(() => vi.fn());
vi.mock("../../../commands/speakerMoveLaneSpan", () => ({
  runMoveSpeakerLaneSpan: moveLane,
}));
const lastProps = vi.hoisted(() => ({
  current: null as null | import("../../../system/ScriptPane").ScriptPaneProps,
}));
vi.mock("../../../system/ScriptPane", async (original) => {
  const actual = await original<typeof import("../../../system/ScriptPane")>();
  const { forwardRef } = await import("react");
  return {
    ...actual,
    ScriptPane: forwardRef<
      import("../../../system/ScriptPane").ScriptPaneHandle,
      import("../../../system/ScriptPane").ScriptPaneProps
    >((props, ref) => {
      lastProps.current = props;
      return <actual.ScriptPane {...props} ref={ref} />;
    }),
  };
});

const word = (name: string) => screen.getByRole("button", { name });
const field = () => screen.getByRole("textbox", { name: /^Fix text/ });
const statuses = () =>
  screen.getAllByRole("status").map((region) => region.textContent);

beforeEach(() => {
  submitWordCorrection.mockReset();
  submitWordCorrection.mockResolvedValue("h1");
  seekTransport.mockReset();
  moveLane.mockReset();
  moveLane.mockResolvedValue({ status: "ok" });
  seedScript();
});

describe("ScriptHost Fix text identity", () => {
  it("stays on the words it opened on when a word is added earlier", async () => {
    render(<ScriptHost />);
    await userEvent.click(word("friends"));
    await userEvent.keyboard("{Enter}");
    expect(field()).toHaveValue("friends");
    // An earlier turn arrives: every window index after it moves by one.
    act(() => {
      const project = useDawStore.getState().project;
      if (!project) throw new Error("no project");
      useDawStore.setState({
        project: {
          ...project,
          transcript: {
            utterances: [
              scriptUtterance("guest", "Anneke", [scriptWord("Hi", 9, 5)]),
              ...scriptUtterances(),
            ],
          },
        },
      });
    });
    expect(field()).toHaveValue("friends");
    await userEvent.type(field(), "!{Enter}");
    expect(submitWordCorrection).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      5,
      5,
      "friends!",
      "friends",
      null,
    );
  });

  it("closes when the words it opened on are gone", async () => {
    render(<ScriptHost />);
    await userEvent.click(word("friends"));
    await userEvent.keyboard("{Enter}");
    act(() => {
      const project = useDawStore.getState().project;
      if (!project) throw new Error("no project");
      useDawStore.setState({
        project: {
          ...project,
          transcript: { utterances: scriptUtterances().slice(1) },
        },
      });
    });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(submitWordCorrection).not.toHaveBeenCalled();
  });
});

describe("ScriptHost Tab to the next unsure word", () => {
  it("puts focus, selection and the announcement on the next word", async () => {
    render(<ScriptHost />);
    await userEvent.click(word("friends"));
    await userEvent.keyboard("{Enter}");
    await userEvent.type(field(), "!{Tab}");
    await act(async () => {});
    expect(useDawStore.getState().selection).toMatchObject({
      startWordIndex: 2,
    });
    expect(word("to (unsure, selected)")).toHaveFocus();
    expect(statuses()).toContain("Unsure word 1 of 2: to");
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Text fixed: friends!",
      undo: "h1",
    });
  });
});

describe("ScriptHost click", () => {
  it("leaves the caret on the word once the selection is cleared", async () => {
    render(<ScriptHost />);
    await userEvent.click(word("back"));
    expect(useDawStore.getState().selection).toMatchObject({
      startWordIndex: 1,
      endWordIndex: 1,
    });
    await userEvent.keyboard("{Escape}");
    expect(useDawStore.getState().selection).toBeNull();
    expect(lastProps.current?.carets).toEqual([{ before: 1 }]);
  });

  it("lets a longer selection take the caret's place", async () => {
    render(<ScriptHost />);
    await userEvent.click(word("back"));
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(lastProps.current?.carets).toEqual([]);
    expect(lastProps.current?.selection).toEqual({
      kind: "words",
      anchor: 1,
      head: 2,
    });
  });
});

describe("ScriptHost while the words are not settled", () => {
  it.each([
    ["transcribing", { kind: "transcribing", progress: 0.4 }],
    ["out of date", { kind: "outOfDate", onUpdate: () => {} }],
  ] as const)("offers no Fix text or speaker change while %s", (_n, status) => {
    render(<ScriptHost status={status} />);
    expect(lastProps.current?.onFixText).toBeUndefined();
    expect(lastProps.current?.onSpeaker).toBeUndefined();
  });

  it("closes an open field when the Script stops being ready, and does not bring it back", async () => {
    const { rerender } = render(<ScriptHost status={{ kind: "ready" }} />);
    await userEvent.click(word("friends"));
    await userEvent.keyboard("{Enter}");
    expect(field()).toBeInTheDocument();
    rerender(<ScriptHost status={{ kind: "transcribing", progress: 0.2 }} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    rerender(<ScriptHost status={{ kind: "ready" }} />);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("closes the speaker popover for good when the Script stops being ready", async () => {
    const { rerender } = render(<ScriptHost status={{ kind: "ready" }} />);
    await userEvent.click(
      screen.getAllByRole("button", { name: /Maya, change speaker/ })[0]!,
    );
    expect(screen.getAllByRole("radio").length).toBeGreaterThan(0);
    rerender(<ScriptHost status={{ kind: "transcribing", progress: 0.2 }} />);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    rerender(<ScriptHost status={{ kind: "ready" }} />);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("does not move the reader when the Script stopped being ready while a fix was sent", async () => {
    let finish: (id: string) => void = () => {};
    submitWordCorrection.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const { rerender } = render(<ScriptHost status={{ kind: "ready" }} />);
    await userEvent.click(word("friends"));
    await userEvent.keyboard("{Enter}");
    await userEvent.type(field(), "!{Tab}");
    rerender(<ScriptHost status={{ kind: "transcribing", progress: 0.2 }} />);
    await act(async () => finish("h1"));
    expect(useDawStore.getState().selection).toMatchObject({
      startWordIndex: 5,
    });
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Text fixed: friends!",
    );
  });
});

describe("ScriptHost empty state", () => {
  beforeEach(() => seedScript({ utterances: [] }));

  it("starts a transcription for the host", () => {
    const onTranscribe = vi.fn();
    render(<ScriptHost onTranscribe={onTranscribe} />);
    screen.getByRole("button", { name: "Transcribe this episode" }).click();
    expect(onTranscribe).toHaveBeenCalledOnce();
  });

  it("does not offer it to a viewer", () => {
    seedScript({
      utterances: [],
      projectPath: "share:abc",
      guestMode: "view",
      shareCapabilities: ["play", "view"],
    });
    render(<ScriptHost onTranscribe={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: "Transcribe this episode" }),
    ).toBeNull();
    expect(screen.getByText("No transcript yet")).toBeInTheDocument();
  });
});

describe("ScriptHost cut words", () => {
  const boundary = {
    id: "b1",
    track_id: "host",
    timeline_join_sec: 12.5,
    has_cutaway: true,
    cutaway_source_start: 12.5,
    cutaway_source_end: 14,
    cutaway_word_ids: [
      {
        track_id: "host",
        source_id: null,
        word_index: -3,
        text: "uh",
        start: 12.5,
        end: 12.9,
      },
      {
        track_id: "host",
        source_id: null,
        word_index: -4,
        text: "well",
        start: 13,
        end: 13.4,
      },
    ],
  } as unknown as EditBoundaryView;

  beforeEach(() => {
    seedScript({
      utterances: [
        scriptUtterance("host", "Maya", [
          scriptWord("Welcome", 0, 12),
          scriptWord("friends", 3, 12.5),
        ]),
      ],
      project: {
        tracks: [
          sampleTrack({ id: "host", speaker: "Maya", speaker_split_id: "s1" }),
          sampleTrack({
            id: "guest",
            speaker: "Anneke",
            speaker_split_id: "s1",
          }),
        ],
        edit_boundaries: [boundary],
      },
    });
    useDawStore.setState({ showCutAwayUtterances: true });
  });

  it("does not seek to them, but seeks to the words around them", async () => {
    render(<ScriptHost />);
    act(() => lastProps.current?.onSeek?.(1));
    act(() => lastProps.current?.onSeek?.(2));
    expect(seekTransport).not.toHaveBeenCalled();
    await userEvent.click(word("friends"));
    expect(seekTransport).toHaveBeenCalledWith(12.5);
  });

  it("refuses Fix text over a span that holds one", () => {
    render(<ScriptHost />);
    act(() => lastProps.current?.onFixText?.({ start: 0, end: 3 }, "enter"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(useDawStore.getState().statusAnnouncement).toBe(FIX_CUT_TEXT);
    act(() => lastProps.current?.onFixText?.({ start: 1, end: 1 }, "enter"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(submitWordCorrection).not.toHaveBeenCalled();
  });

  it("moves a turn to another lane without the cut words in its range", async () => {
    render(<ScriptHost />);
    await userEvent.click(
      screen.getAllByRole("button", { name: /Maya, change speaker/ })[0]!,
    );
    await userEvent.click(screen.getByRole("radio", { name: /Anneke/ }));
    expect(moveLane).toHaveBeenCalled();
    expect(useDawStore.getState().selection).toMatchObject({
      trackId: "host",
      startWordIndex: 0,
      endWordIndex: 3,
    });
  });
});
