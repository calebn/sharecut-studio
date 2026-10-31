import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../../state/dawStore";
import {
  scriptUtterances,
  scriptWord,
  seedScript,
} from "../../../test/scriptHostKit";
import { ScriptHost } from "./ScriptHost";

const seekTransport = vi.hoisted(() => vi.fn());
vi.mock("../../../commands/seek", () => ({ seekTransport }));
const paneRenders = vi.hoisted(() => vi.fn());
vi.mock("../../../system/ScriptPane", async (original) => {
  const actual = await original<typeof import("../../../system/ScriptPane")>();
  const { forwardRef } = await import("react");
  return {
    ...actual,
    ScriptPane: forwardRef<
      import("../../../system/ScriptPane").ScriptPaneHandle,
      import("../../../system/ScriptPane").ScriptPaneProps
    >((props, ref) => {
      paneRenders();
      return <actual.ScriptPane {...props} ref={ref} />;
    }),
  };
});

const word = (name: string) => screen.getByRole("button", { name });
const selection = () => useDawStore.getState().selection;

beforeEach(() => {
  seekTransport.mockReset();
  seedScript();
});

describe("ScriptHost reading", () => {
  it("draws the transcript as turns by speaker", () => {
    render(<ScriptHost />);
    expect(word("Welcome")).toBeInTheDocument();
    expect(word("Thanks")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Script" })).toHaveAttribute(
      "data-layout",
      "desktop",
    );
  });

  it("follows the shell breakpoint unless told", () => {
    useDawStore.setState({ shellBreakpoint: "phone" });
    const { rerender } = render(<ScriptHost />);
    expect(screen.getByRole("region", { name: "Script" })).toHaveAttribute(
      "data-layout",
      "phone",
    );
    rerender(<ScriptHost layout="desktop" />);
    expect(screen.getByRole("region", { name: "Script" })).toHaveAttribute(
      "data-layout",
      "desktop",
    );
    useDawStore.setState({ shellBreakpoint: "desktop" });
  });

  it("toggles show cut text through the store", async () => {
    render(<ScriptHost />);
    const toggle = screen.getByRole("button", { name: "Show cut text" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    expect(useDawStore.getState().showCutAwayUtterances).toBe(true);
    expect(
      screen.getByRole("button", { name: "Show cut text" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

describe("ScriptHost statuses", () => {
  it("shows loading while the words are still hydrating", () => {
    seedScript({
      project: {
        meta: {
          name: "x",
          workspace_dir: "/t",
          hydration: { transcript_words: false },
        } as never,
      },
    });
    render(<ScriptHost />);
    expect(screen.queryByRole("button", { name: "Welcome" })).toBeNull();
    expect(document.querySelector(".sys-skeleton, [aria-busy]")).not.toBeNull();
  });

  it("shows the empty state when there are no words, and asks to transcribe", async () => {
    seedScript({ utterances: [] });
    const onTranscribe = vi.fn();
    render(<ScriptHost onTranscribe={onTranscribe} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Transcribe this episode" }),
    );
    expect(onTranscribe).toHaveBeenCalledOnce();
  });

  it("shows transcribing with its progress", () => {
    render(
      <ScriptHost
        status={{
          kind: "transcribing",
          progress: 0.4,
          notYet: "12:00 to 52:10",
        }}
      />,
    );
    expect(screen.getByText("40%")).toBeInTheDocument();
    expect(screen.getByText(/Not transcribed yet/)).toBeInTheDocument();
    expect(word("Welcome")).toBeInTheDocument();
  });

  it("shows out of date with an Update action", async () => {
    const onUpdate = vi.fn();
    render(<ScriptHost status={{ kind: "outOfDate", onUpdate }} />);
    expect(screen.getByText("Transcript out of date")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("takes an explicit ready status like the default", () => {
    render(<ScriptHost status={{ kind: "ready" }} />);
    expect(word("Welcome")).toBeInTheDocument();
  });
});

describe("ScriptHost selection", () => {
  it("writes a transcriptRange for words on one track", async () => {
    render(<ScriptHost />);
    await userEvent.click(word("back"));
    expect(selection()).toEqual({
      kind: "transcriptRange",
      trackId: "host",
      sourceId: null,
      startWordIndex: 1,
      endWordIndex: 1,
    });
    await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{/Shift}");
    expect(selection()).toMatchObject({
      kind: "transcriptRange",
      startWordIndex: 1,
      endWordIndex: 3,
    });
  });

  it("writes a time range over both tracks for a selection across speakers", async () => {
    render(<ScriptHost />);
    await userEvent.click(word("friends"));
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    const now = selection();
    expect(now?.kind).toBe("range");
    if (now?.kind !== "range") return;
    expect([...now.target.track_ids].sort()).toEqual(["guest", "host"]);
    expect(now.target.intervals[0]?.start).toBeCloseTo(12.5);
  });

  it("shows a stored word selection and clears it with Escape", async () => {
    useDawStore.getState().setSelection({
      kind: "transcriptRange",
      trackId: "guest",
      sourceId: null,
      startWordIndex: 0,
      endWordIndex: 1,
    });
    render(<ScriptHost />);
    expect(word("Thanks (selected)")).toBeInTheDocument();
    expect(word("so (selected)")).toBeInTheDocument();
    word("Thanks (selected)").focus();
    await userEvent.keyboard("{Escape}");
    expect(selection()).toBeNull();
  });

  it("seeks on a click to the word's timeline start", async () => {
    render(<ScriptHost />);
    await userEvent.click(word("Thanks"));
    expect(seekTransport).toHaveBeenCalledWith(14);
  });

  it("does not seek a cut word", async () => {
    seedScript({
      utterances: [
        {
          ...scriptUtterances()[0]!,
          words: [
            scriptWord("Welcome", 0, 10),
            scriptWord("gone", 1, 10.5, {
              mappable: false,
              timeline_start: null,
              timeline_end: null,
            }),
          ],
        },
      ],
    });
    useDawStore.setState({ showCutAwayUtterances: true });
    render(<ScriptHost />);
    seekTransport.mockClear();
    await userEvent.click(word("Welcome"));
    expect(seekTransport).toHaveBeenCalledTimes(1);
  });

  it("seeks to the turn when its time is pressed", async () => {
    render(<ScriptHost />);
    await userEvent.click(
      screen.getByRole("button", { name: "Play from 0:14" }),
    );
    expect(seekTransport).toHaveBeenCalled();
  });
});

describe("ScriptHost following", () => {
  it("turns follow off on the reader's own scroll and back on with Back to playhead", async () => {
    seedScript({ playheadSec: 10.6, transcriptFollowPlayhead: true });
    render(<ScriptHost />);
    const body = document.querySelector(".sys-script-body") as HTMLElement;
    fireEvent.wheel(body);
    fireEvent.scroll(body);
    expect(useDawStore.getState().transcriptFollowPlayhead).toBe(false);
    await userEvent.click(
      screen.getByRole("button", { name: "Back to playhead" }),
    );
    expect(useDawStore.getState().transcriptFollowPlayhead).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Back to playhead" }),
    ).toBeNull();
  });

  it("marks the playing word and moves it with the playhead", () => {
    seedScript({ playheadSec: 10.6 });
    render(<ScriptHost />);
    expect(word("back").closest("[data-playing]")).not.toBeNull();
    act(() => useDawStore.setState({ playheadSec: 14.1 }));
    expect(word("Thanks").closest("[data-playing]")).not.toBeNull();
    expect(word("back").closest("[data-playing]")).toBeNull();
  });

  it("renders the pane again only when the playing word changes", () => {
    seedScript({ playheadSec: 10.05 });
    render(<ScriptHost />);
    paneRenders.mockClear();
    act(() => useDawStore.setState({ playheadSec: 10.1 }));
    act(() => useDawStore.setState({ playheadSec: 10.3 }));
    expect(paneRenders).not.toHaveBeenCalled();
    act(() => useDawStore.setState({ playheadSec: 10.6 }));
    expect(paneRenders).toHaveBeenCalledTimes(1);
  });
});
