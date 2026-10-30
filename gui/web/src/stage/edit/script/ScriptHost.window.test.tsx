import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../../state/dawStore";
import {
  scriptUtterance,
  scriptWord,
  seedScript,
} from "../../../test/scriptHostKit";
import type { CombinedUtterance } from "../../../types/project";
import { ScriptHost } from "./ScriptHost";
import { WINDOW_LIMIT, WINDOW_MARGIN } from "./useScriptWindow";

const seekTransport = vi.hoisted(() => vi.fn());
vi.mock("../../../commands/seek", () => ({ seekTransport }));
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

const TURNS = 400;
/** One two-word turn per speaker change; turn n holds words "a{n}" and "b{n}", and turns 5 and 350 each have an unsure word. */
function longTranscript(): CombinedUtterance[] {
  return Array.from({ length: TURNS }, (_, n) => {
    const track = n % 2 === 0 ? "host" : "guest";
    const at = Math.floor(n / 2) * 2;
    return scriptUtterance(track, track === "host" ? "Maya" : "Anneke", [
      scriptWord(`a${n}`, at, n * 2, { unsure: n === 5 || n === 350 }),
      scriptWord(`b${n}`, at + 1, n * 2 + 1),
    ]);
  });
}

const has = (name: string) => screen.queryByRole("button", { name }) !== null;
const hasWord = (text: string) =>
  [...document.querySelectorAll(".sys-script-word")].some(
    (el) => el.textContent === text,
  );

beforeEach(() => {
  seekTransport.mockReset();
  seedScript({ utterances: longTranscript() });
});

describe("ScriptHost unsure words", () => {
  it("counts unsure words over the episode and leaves out a bleed-only row", () => {
    seedScript();
    render(<ScriptHost />);
    expect(
      screen.getByRole("button", { name: "2 unsure words, go to the next" }),
    ).toBeInTheDocument();
  });

  it("jumps to each unsure word in turn, wrapping, and says where it is", async () => {
    seedScript();
    render(<ScriptHost />);
    const chip = () =>
      screen.getByRole("button", { name: /unsure words, go to/ });
    await userEvent.click(chip());
    expect(useDawStore.getState().selection).toMatchObject({
      trackId: "host",
      startWordIndex: 2,
      endWordIndex: 2,
    });
    expect(seekTransport).toHaveBeenLastCalledWith(11);
    expect(screen.getAllByRole("status").map((r) => r.textContent)).toContain(
      "Unsure word 1 of 2: to",
    );
    await userEvent.click(chip());
    expect(useDawStore.getState().selection).toMatchObject({
      startWordIndex: 7,
    });
    await userEvent.click(chip());
    expect(useDawStore.getState().selection).toMatchObject({
      startWordIndex: 2,
    });
    expect(screen.getAllByRole("status").map((r) => r.textContent)).toContain(
      "Unsure word 1 of 2: to",
    );
  });

  it("never lands on the bleed-only row's unsure word", async () => {
    seedScript();
    render(<ScriptHost />);
    const chip = screen.getByRole("button", { name: /unsure words, go to/ });
    for (let n = 0; n < 4; n++) await userEvent.click(chip);
    expect(useDawStore.getState().selection).not.toMatchObject({
      trackId: "guest",
      startWordIndex: 4,
    });
  });
});

describe("ScriptHost window", () => {
  it("draws only a window of a long transcript, around the start", () => {
    render(<ScriptHost />);
    expect(TURNS).toBeGreaterThan(WINDOW_LIMIT);
    expect(hasWord("a0")).toBe(true);
    expect(hasWord(`a${WINDOW_MARGIN}`)).toBe(true);
    expect(hasWord(`a${WINDOW_MARGIN + 20}`)).toBe(false);
    expect(hasWord(`a${TURNS - 1}`)).toBe(false);
  });

  it("keeps the unsure count for the whole episode", () => {
    render(<ScriptHost />);
    expect(
      screen.getByRole("button", { name: "2 unsure words, go to the next" }),
    ).toBeInTheDocument();
  });

  it("widens to a far word when the jump needs it", async () => {
    render(<ScriptHost />);
    const chip = screen.getByRole("button", { name: /unsure words, go to/ });
    await userEvent.click(chip);
    await userEvent.click(chip);
    expect(hasWord("a350")).toBe(true);
    expect(useDawStore.getState().selection).toMatchObject({
      trackId: "host",
      startWordIndex: 350,
    });
  });

  it("keeps the window on the last word spoken when the playhead is in a pause", () => {
    seedScript({
      utterances: longTranscript(),
      playheadSec: 600.7,
      transcriptFollowPlayhead: true,
    });
    render(<ScriptHost />);
    expect(hasWord("a300")).toBe(true);
  });

  it("follows the playhead and moves the window with it", () => {
    seedScript({
      utterances: longTranscript(),
      playheadSec: 600.2,
      transcriptFollowPlayhead: true,
    });
    render(<ScriptHost />);
    expect(hasWord("a300")).toBe(true);
    expect(hasWord("a0")).toBe(false);
  });

  it("widens when a caret lands near the window's edge", () => {
    render(<ScriptHost />);
    expect(hasWord(`a${WINDOW_MARGIN + 20}`)).toBe(false);
    const last = (WINDOW_MARGIN + 1) * 2 - 1;
    act(() => lastProps.current?.onCaret?.(last));
    expect(hasWord(`a${WINDOW_MARGIN + 20}`)).toBe(true);
  });

  it("widens when a selection ends near the window's edge", () => {
    render(<ScriptHost />);
    const last = (WINDOW_MARGIN + 1) * 2 - 1;
    act(() =>
      lastProps.current?.onSelect?.({
        kind: "words",
        anchor: last - 1,
        head: last,
      }),
    );
    expect(hasWord(`a${WINDOW_MARGIN + 20}`)).toBe(true);
  });

  it("widens when the reader scrolls near the end of the body", () => {
    render(<ScriptHost />);
    const body = document.querySelector(".sys-script-body") as HTMLElement;
    Object.defineProperty(body, "scrollHeight", {
      value: 5000,
      configurable: true,
    });
    Object.defineProperty(body, "clientHeight", {
      value: 600,
      configurable: true,
    });
    body.scrollTop = 4300;
    fireEvent.scroll(body);
    expect(hasWord(`a${WINDOW_MARGIN + 20}`)).toBe(true);
  });

  it("shows everything of a short transcript", () => {
    seedScript();
    render(<ScriptHost />);
    expect(has("Hello")).toBe(true);
  });
});
