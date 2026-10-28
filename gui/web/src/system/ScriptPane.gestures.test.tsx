import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptPane, type ScriptPaneProps } from "./ScriptPane";
import {
  CUT,
  patchWords,
  SCRIPT_TURNS,
  spanPatch,
  suggestedMark,
} from "./scriptFixtures";

const words = (anchor: number, head: number) => ({
  kind: "words" as const,
  anchor,
  head,
});

const word = (name: string) => screen.getByRole("button", { name });
const stop = (index: number) =>
  document.querySelector(`[data-stop="${index}"]`) as HTMLElement;

/** The mouse. `isPrimary` is true for the first pointer of a kind. */
const MOUSE = { pointerId: 1, pointerType: "mouse", isPrimary: true } as const;
const FINGER = { pointerId: 7, pointerType: "touch", isPrimary: true } as const;

/** Five places to a line, 60 px apart, lines 26 px apart: jsdom has no layout. */
const rectAt = (at: number) =>
  new DOMRect((at % 5) * 60, Math.floor(at / 5) * 26, 50, 20);
const rectOf = (el: HTMLElement) => {
  const at = Number(el.dataset.stop);
  return Number.isNaN(at) ? new DOMRect(0, 0, 0, 0) : rectAt(at);
};
const centre = (index: number) => {
  const r = rectAt(index);
  return { clientX: r.x + 25, clientY: r.y + 10 };
};

/** The stop at a point in the grid, or none in a gap, as `elementFromPoint` would answer. */
function layout(bodyBox = new DOMRect(0, 0, 300, 200)) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("sys-script-body")
        ? bodyBox
        : rectOf(this);
    },
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    function (this: HTMLElement) {
      return [rectOf(this)] as unknown as DOMRectList;
    },
  );
  document.elementFromPoint = (x: number, y: number) => {
    const column = Math.floor(x / 60);
    const row = Math.floor(y / 26);
    const at = row * 5 + column;
    if (x % 60 >= 50 || y % 26 >= 20 || column > 4) return null;
    return document.querySelector(`[data-stop="${at}"]`);
  };
}

function setup(over: Partial<ScriptPaneProps> = {}) {
  const calls = {
    onCaret: vi.fn(),
    onSelect: vi.fn(),
    onSeek: vi.fn(),
    onPrimary: vi.fn(),
    onSelectionStart: vi.fn(),
    onSelectionChange: vi.fn(),
    onSelectionEnd: vi.fn(),
    onFixText: vi.fn(),
    onUserScroll: vi.fn(),
  };
  const view = render(<ScriptPane turns={SCRIPT_TURNS} {...calls} {...over} />);
  const body = view.container.querySelector<HTMLElement>(
    ".sys-script-body",
  ) as HTMLElement;
  return { ...calls, ...view, body };
}

const drag = (
  target: HTMLElement,
  from: number,
  to: number,
  init: Record<string, unknown> = MOUSE,
) => {
  fireEvent.pointerDown(target, { ...init, ...centre(from) });
  fireEvent.pointerMove(target, { ...init, ...centre(from), clientX: 100 });
  fireEvent.pointerMove(target, { ...init, ...centre(to) });
};

/** Move the fake clock, and React with it. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => layout());

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
});

describe("ScriptPane mouse drag", () => {
  it("selects from the pressed word across turns, previews while it runs and commits once on release", () => {
    const {
      body,
      onSelect,
      onSelectionStart,
      onSelectionChange,
      onSelectionEnd,
    } = setup();
    drag(stop(12), 12, 22);
    const gesture = {
      source: "mouse",
      intent: "drag",
      shift: false,
      alt: false,
      mod: false,
    };
    expect(onSelectionStart.mock.calls).toEqual([[12, gesture]]);
    expect(onSelectionChange.mock.calls.at(-1)).toEqual([12, 22, gesture]);
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      [...body.querySelectorAll("[data-selected].sys-script-word")].length,
    ).toBe(11);
    expect(body).toHaveAttribute("data-selecting");
    expect(screen.getByRole("status")).toHaveTextContent("");
    fireEvent.pointerUp(body, { ...MOUSE, ...centre(22) });
    expect(onSelect.mock.calls).toEqual([[words(12, 22)]]);
    expect(onSelectionEnd.mock.calls).toEqual([
      [12, 22, { ...gesture, committed: true }],
    ]);
    expect(body).not.toHaveAttribute("data-selecting");
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("selects backwards and shrinks when the pointer comes back", () => {
    const { body, onSelect } = setup();
    drag(stop(13), 13, 8);
    fireEvent.pointerMove(body, { ...MOUSE, ...centre(11) });
    fireEvent.pointerUp(body, { ...MOUSE, ...centre(11) });
    expect(onSelect.mock.calls).toEqual([[words(13, 11)]]);
  });

  it("takes a cut pill and a suggested run whole when the drag reaches into them", () => {
    const turns = patchWords(SCRIPT_TURNS, {
      ...spanPatch(2, 4, { mark: CUT }),
      ...spanPatch(7, 8, { mark: suggestedMark("s1") }),
    });
    const { body, onSelect } = setup({ turns });
    drag(stop(1), 1, 3);
    fireEvent.pointerUp(body, { ...MOUSE, ...centre(3) });
    expect(onSelect.mock.calls).toEqual([[words(1, 4)]]);
    onSelect.mockClear();
    drag(stop(5), 5, 7);
    fireEvent.pointerUp(body, { ...MOUSE, ...centre(7) });
    expect(onSelect.mock.calls).toEqual([[words(5, 8)]]);
  });

  it("does not start from a pill, a run, a margin control or a grip", () => {
    const turns = patchWords(SCRIPT_TURNS, spanPatch(2, 4, { mark: CUT }));
    const { onSelectionStart } = setup({ turns, onSeekTurn: vi.fn() });
    drag(screen.getByRole("button", { name: /^Cut, / }), 2, 8);
    drag(screen.getByRole("button", { name: "Play from 12:04" }), 0, 8);
    expect(onSelectionStart).not.toHaveBeenCalled();
  });

  it("is a click when the pointer stays inside the slop: the word is selected and the playhead seeks", () => {
    const { onSelect, onSeek, onCaret, onSelectionStart, body } = setup();
    const target = word("small");
    fireEvent.pointerDown(target, { ...MOUSE, ...centre(12) });
    const near = {
      clientX: centre(12).clientX + 2,
      clientY: centre(12).clientY,
    };
    fireEvent.pointerMove(target, { ...MOUSE, ...near });
    fireEvent.pointerUp(target, { ...MOUSE, ...near });
    fireEvent.click(target, { detail: 1 });
    expect(onSelectionStart).not.toHaveBeenCalled();
    expect(onCaret.mock.calls).toEqual([[12]]);
    expect(onSeek.mock.calls).toEqual([[12]]);
    expect(onSelect.mock.calls).toEqual([[words(12, 12)]]);
    expect(body).not.toHaveAttribute("data-selecting");
  });

  it("swallows the click that follows a drag, once", () => {
    const { body, onSelect, onCaret } = setup();
    drag(stop(12), 12, 14);
    fireEvent.pointerUp(body, { ...MOUSE, ...centre(14) });
    onSelect.mockClear();
    fireEvent.click(stop(14), { detail: 1 });
    expect(onCaret).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(stop(14), { detail: 1 });
    expect(onCaret).toHaveBeenCalledTimes(1);
  });

  it("puts focus on the word the drag ended on, so the keyboard goes on from the head", () => {
    const { body } = setup();
    drag(stop(12), 12, 14);
    fireEvent.pointerUp(body, { ...MOUSE, ...centre(14) });
    expect(stop(14)).toHaveFocus();
  });

  it("Shift-click extends from the caret and Shift-drag from the selection's own anchor", () => {
    const { onSelect, body } = setup({ selection: words(12, 13) });
    fireEvent.pointerDown(word("room (selected)"), {
      ...MOUSE,
      ...centre(13),
      shiftKey: true,
    });
    fireEvent.pointerMove(body, { ...MOUSE, ...centre(17), shiftKey: true });
    fireEvent.pointerUp(body, { ...MOUSE, ...centre(17), shiftKey: true });
    expect(onSelect.mock.calls).toEqual([[words(12, 17)]]);
    onSelect.mockClear();
    fireEvent.click(word("room (selected)"), { shiftKey: true, detail: 1 });
    expect(onSelect.mock.calls).toEqual([]);
  });

  it("reports Shift as the extend intent", () => {
    const { onSelectionStart } = setup({ selection: words(12, 13) });
    fireEvent.pointerDown(word("room (selected)"), {
      ...MOUSE,
      ...centre(13),
      shiftKey: true,
    });
    fireEvent.pointerMove(word("room (selected)"), {
      ...MOUSE,
      ...centre(17),
      shiftKey: true,
    });
    expect(onSelectionStart.mock.calls[0]).toEqual([
      12,
      {
        source: "mouse",
        intent: "extend",
        shift: true,
        alt: false,
        mod: false,
      },
    ]);
  });

  it("ignores a right button and a Ctrl press", () => {
    const { onSelectionStart } = setup();
    for (const extra of [{ button: 2 }, { ctrlKey: true }]) {
      drag(stop(12), 12, 14, { ...MOUSE, ...extra });
    }
    expect(onSelectionStart).not.toHaveBeenCalled();
  });

  it("is refused when the host returns false, and the click stays a click", () => {
    const { body, onSelect, onSelectionEnd } = setup({
      onSelectionStart: vi.fn(() => false),
    });
    drag(stop(12), 12, 14);
    fireEvent.pointerUp(body, { ...MOUSE, ...centre(14) });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onSelectionEnd).not.toHaveBeenCalled();
    expect(body).not.toHaveAttribute("data-selecting");
  });

  it("does nothing without onSelect, as a guest's pane without selection", () => {
    const { onSelectionStart } = setup({ onSelect: undefined });
    drag(stop(12), 12, 14);
    expect(onSelectionStart).not.toHaveBeenCalled();
  });
});

describe("ScriptPane drag ends without a commit", () => {
  const ended = (fn: ReturnType<typeof vi.fn>) =>
    fn.mock.calls.map(([anchor, head, g]) => [anchor, head, g.committed]);

  it("Escape cancels and does not reach the window keymap", () => {
    const { onSelect, onSelectionEnd, body } = setup({
      selection: words(0, 1),
    });
    const window_ = vi.fn();
    window.addEventListener("keydown", window_);
    drag(stop(12), 12, 14);
    const prevented = !fireEvent.keyDown(document.body, { key: "Escape" });
    window.removeEventListener("keydown", window_);
    expect(prevented).toBe(true);
    expect(window_).not.toHaveBeenCalled();
    expect(ended(onSelectionEnd)).toEqual([[12, 14, false]]);
    expect(onSelect).not.toHaveBeenCalled();
    expect(body).not.toHaveAttribute("data-selecting");
    expect(
      [...body.querySelectorAll("[data-selected].sys-script-word")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["Welcome", "back"]);
    fireEvent.pointerUp(body, { ...MOUSE, ...centre(14) });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a pointercancel, a lost capture, a window blur and unmounting each end it uncommitted", () => {
    for (const end of ["cancel", "lost", "blur", "unmount"] as const) {
      const { body, onSelect, onSelectionEnd, unmount } = setup();
      drag(stop(12), 12, 14);
      if (end === "cancel") fireEvent.pointerCancel(body, MOUSE);
      if (end === "lost") fireEvent.lostPointerCapture(body, MOUSE);
      if (end === "blur") fireEvent.blur(window);
      unmount();
      expect(ended(onSelectionEnd), end).toEqual([[12, 14, false]]);
      expect(onSelect, end).not.toHaveBeenCalled();
    }
  });

  it("ignores a second pointer while a mouse drag runs", () => {
    const { body, onSelect, onSelectionStart } = setup();
    drag(stop(12), 12, 14);
    fireEvent.pointerDown(word("sound"), {
      pointerId: 9,
      pointerType: "touch",
      isPrimary: false,
      ...centre(16),
    });
    fireEvent.pointerMove(body, {
      pointerId: 9,
      pointerType: "touch",
      ...centre(20),
    });
    fireEvent.pointerUp(body, { pointerId: 9, pointerType: "touch" });
    expect(onSelectionStart).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(body, { ...MOUSE, ...centre(14) });
    expect(onSelect.mock.calls).toEqual([[words(12, 14)]]);
  });
});

describe("ScriptPane touch", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "Date",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    });
  });

  it("a long press selects the word and a drag extends it, committing on lift", () => {
    const {
      body,
      onSelect,
      onSelectionStart,
      onSelectionChange,
      onSelectionEnd,
    } = setup();
    fireEvent.pointerDown(word("small"), { ...FINGER, ...centre(12) });
    advance(499);
    expect(onSelectionStart).not.toHaveBeenCalled();
    advance(1);
    const gesture = {
      source: "touch",
      intent: "hold",
      shift: false,
      alt: false,
      mod: false,
    };
    expect(onSelectionStart.mock.calls).toEqual([[12, gesture]]);
    expect(onSelectionChange.mock.calls).toEqual([[12, 12, gesture]]);
    expect(word("small (selected)")).toBeInTheDocument();
    fireEvent.pointerMove(body, { ...FINGER, ...centre(14) });
    expect(onSelectionChange.mock.calls.at(-1)).toEqual([12, 14, gesture]);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.pointerUp(body, { ...FINGER, ...centre(14) });
    expect(onSelect.mock.calls).toEqual([[words(12, 14)]]);
    expect(onSelectionEnd.mock.calls).toEqual([
      [12, 14, { ...gesture, committed: true }],
    ]);
  });

  it("a hold that never moves selects just that word, with its grips", () => {
    const { body, onSelect } = setup();
    fireEvent.pointerDown(word("small"), { ...FINGER, ...centre(12) });
    advance(500);
    fireEvent.pointerUp(body, { ...FINGER, ...centre(12) });
    expect(onSelect.mock.calls).toEqual([[words(12, 12)]]);
    fireEvent.click(stop(12), { detail: 1 });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("a finger that moves before the hold scrolls and selects nothing", () => {
    const { body, onSelect, onSelectionStart } = setup();
    fireEvent.pointerDown(word("small"), { ...FINGER, ...centre(12) });
    fireEvent.pointerMove(body, { ...FINGER, clientX: 100, clientY: 130 });
    advance(1000);
    fireEvent.pointerCancel(body, FINGER);
    expect(onSelectionStart).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a finger that drifts under the touch slop still holds", () => {
    const { onSelectionStart, body } = setup();
    fireEvent.pointerDown(word("small"), { ...FINGER, ...centre(12) });
    const at = centre(12);
    fireEvent.pointerMove(body, {
      ...FINGER,
      clientX: at.clientX + 6,
      clientY: at.clientY + 6,
    });
    advance(500);
    expect(onSelectionStart).toHaveBeenCalledTimes(1);
  });

  it("stops the page from scrolling under the finger only once the hold has armed", () => {
    const { body } = setup();
    fireEvent.pointerDown(word("small"), { ...FINGER, ...centre(12) });
    expect(fireEvent.touchMove(body, { cancelable: true })).toBe(true);
    advance(500);
    expect(fireEvent.touchMove(body, { cancelable: true })).toBe(false);
    fireEvent.pointerUp(body, { ...FINGER, ...centre(12) });
    expect(fireEvent.touchMove(body, { cancelable: true })).toBe(true);
  });

  it("keeps the system menu and text selection away while a finger is down", () => {
    const { body } = setup();
    expect(fireEvent.contextMenu(body)).toBe(true);
    fireEvent.pointerDown(word("small"), { ...FINGER, ...centre(12) });
    expect(fireEvent.contextMenu(body)).toBe(false);
    expect(
      fireEvent(body, new Event("selectstart", { cancelable: true })),
    ).toBe(false);
  });

  it("a second finger cancels the drag and leaves the earlier selection", () => {
    const { body, onSelect, onSelectionEnd } = setup({
      selection: words(0, 1),
    });
    fireEvent.pointerDown(word("small"), { ...FINGER, ...centre(12) });
    advance(500);
    fireEvent.pointerMove(body, { ...FINGER, ...centre(14) });
    fireEvent.pointerDown(body, {
      pointerId: 8,
      pointerType: "touch",
      isPrimary: false,
      ...centre(30),
    });
    expect(
      onSelectionEnd.mock.calls.map(([a, h, g]) => [a, h, g.committed]),
    ).toEqual([[12, 14, false]]);
    fireEvent.pointerUp(body, { ...FINGER, ...centre(14) });
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      [...body.querySelectorAll("[data-selected].sys-script-word")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["Welcome", "back"]);
  });

  it("a tap selects the word, and a second tap on it soon after is a double tap", () => {
    const { onSelect, onFixText } = setup();
    const tap = () => {
      fireEvent.pointerDown(word("small"), { ...FINGER, ...centre(12) });
      fireEvent.pointerUp(word("small"), { ...FINGER, ...centre(12) });
      fireEvent.click(word("small"), { detail: 1 });
    };
    tap();
    expect(onSelect.mock.calls).toEqual([[words(12, 12)]]);
    expect(onFixText).not.toHaveBeenCalled();
    advance(349);
    tap();
    expect(onFixText.mock.calls).toEqual([
      [{ start: 12, end: 12 }, "double-tap"],
    ]);
    tap();
    expect(onFixText).toHaveBeenCalledTimes(1);
  });

  it("a second tap too late, or on another word, is only a tap", () => {
    const { onFixText } = setup();
    const tap = (at: number) => {
      fireEvent.pointerDown(stop(at), { ...FINGER, ...centre(at) });
      fireEvent.pointerUp(stop(at), { ...FINGER, ...centre(at) });
      fireEvent.click(stop(at), { detail: 1 });
    };
    tap(12);
    advance(350);
    tap(12);
    tap(13);
    expect(onFixText).not.toHaveBeenCalled();
  });
});

describe("ScriptPane edge scrolling", () => {
  it("scrolls the body while a drag sits in the bottom band, re-reading the head, and stops at the end", () => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout"],
    });
    const { body, onUserScroll, onSelectionChange } = setup();
    let top = 0;
    Object.defineProperty(body, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.min(value, 60);
      },
    });
    drag(stop(12), 12, 14);
    const inBand = { ...MOUSE, clientX: 10, clientY: 190 };
    fireEvent.pointerMove(body, inBand);
    advance(16);
    expect(top).toBeGreaterThan(0);
    advance(16 * 40);
    expect(top).toBe(60);
    expect(onUserScroll).toHaveBeenCalledTimes(1);
    const calls = onSelectionChange.mock.calls.length;
    advance(16 * 10);
    expect(onSelectionChange.mock.calls.length).toBe(calls);
    fireEvent.pointerUp(body, inBand);
  });

  it("does not scroll when the pointer is in the middle", () => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
    });
    const { body } = setup();
    let top = 0;
    Object.defineProperty(body, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    });
    drag(stop(12), 12, 14);
    advance(200);
    expect(top).toBe(0);
  });
});

describe("ScriptPane Fix text triggers", () => {
  it("a double-click starts Fix text on the word, and a single click does not", () => {
    const { onFixText } = setup();
    fireEvent.click(word("small"), { detail: 1 });
    expect(onFixText).not.toHaveBeenCalled();
    fireEvent.click(word("small"), { detail: 2 });
    expect(onFixText.mock.calls).toEqual([
      [{ start: 12, end: 12 }, "double-click"],
    ]);
  });

  it("Enter on a selected word starts Fix text on the whole selection; on another word it selects that word", async () => {
    const user = userEvent.setup();
    const { onFixText, onSelect, onPrimary } = setup({
      selection: words(12, 14),
    });
    word("room (selected)").focus();
    await user.keyboard("{Enter}");
    expect(onFixText.mock.calls).toEqual([[{ start: 12, end: 14 }, "enter"]]);
    expect(onPrimary).not.toHaveBeenCalled();
    word("sound").focus();
    await user.keyboard("{Enter}");
    expect(onSelect.mock.calls).toEqual([[words(15, 15)]]);
    expect(onFixText).toHaveBeenCalledTimes(1);
  });

  it("F2 starts Fix text on the selection when the word is in it, else on that word, and is the pane's key", () => {
    const { onFixText, onSelect } = setup({ selection: words(12, 14) });
    const window_ = vi.fn();
    window.addEventListener("keydown", window_);
    expect(fireEvent.keyDown(word("room (selected)"), { key: "F2" })).toBe(
      false,
    );
    fireEvent.keyDown(word("sound"), { key: "F2" });
    window.removeEventListener("keydown", window_);
    expect(window_).not.toHaveBeenCalled();
    expect(onFixText.mock.calls).toEqual([
      [{ start: 12, end: 14 }, "f2"],
      [{ start: 15, end: 15 }, "f2"],
    ]);
    expect(onSelect.mock.calls).toEqual([[words(15, 15)]]);
  });

  it("without onFixText, Enter runs the primary and F2 goes on to the keymap", () => {
    const { onPrimary } = setup({
      selection: words(12, 14),
      onFixText: undefined,
    });
    fireEvent.keyDown(word("room (selected)"), { key: "Enter" });
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(fireEvent.keyDown(word("room (selected)"), { key: "F2" })).toBe(
      true,
    );
  });

  it("F2 on a cut pill is not Fix text", () => {
    const turns = patchWords(SCRIPT_TURNS, spanPatch(2, 4, { mark: CUT }));
    const { onFixText } = setup({ turns });
    expect(
      fireEvent.keyDown(screen.getByRole("button", { name: /^Cut, / }), {
        key: "F2",
      }),
    ).toBe(true);
    expect(onFixText).not.toHaveBeenCalled();
  });

  it("typing never edits: letters on a selected word reach the keymap untouched", async () => {
    const user = userEvent.setup();
    const { onFixText, onSelect, onPrimary } = setup({
      selection: words(12, 14),
    });
    const seen: string[] = [];
    const record = (event: KeyboardEvent) => {
      seen.push(`${event.key}:${event.defaultPrevented}`);
    };
    window.addEventListener("keydown", record);
    word("room (selected)").focus();
    await user.keyboard("cxim.a");
    window.removeEventListener("keydown", record);
    expect(seen).toEqual([
      "c:false",
      "x:false",
      "i:false",
      "m:false",
      ".:false",
      "a:false",
    ]);
    expect(onFixText).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onPrimary).not.toHaveBeenCalled();
  });
});

describe("ScriptPane text selection and copy", () => {
  it("copies the selected words as text, a line to a turn, with the collapsed cut left out", () => {
    const turns = patchWords(SCRIPT_TURNS, spanPatch(14, 14, { mark: CUT }));
    const { body } = setup({ turns, selection: words(12, 22) });
    const data = new Map<string, string>();
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.assign(event, {
      clipboardData: { setData: (k: string, v: string) => data.set(k, v) },
    });
    expect(body.dispatchEvent(event)).toBe(false);
    expect([...data]).toEqual([
      ["text/plain", "small room sound like a large one.\nThanks for having"],
    ]);
  });

  it("leaves a copy with a cut or nothing selected to the browser", () => {
    const { body } = setup({ selection: { kind: "cut", id: "x" } });
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.assign(event, { clipboardData: { setData: vi.fn() } });
    expect(body.dispatchEvent(event)).toBe(true);
  });

  it("exposes anchors for the host: the word's key and the turn's id", () => {
    setup();
    expect(word("small")).toHaveAttribute("data-word-key", "episode:12");
    expect(screen.getAllByRole("group")[0]).toHaveAttribute(
      "data-turn-id",
      "t1",
    );
  });
});
