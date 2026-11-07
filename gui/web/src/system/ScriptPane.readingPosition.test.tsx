import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createRef, StrictMode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeResizeObserver, stubResizeObserver } from "../test/resizeObserver";
import {
  ScriptPane,
  type ScriptPaneHandle,
  type ScriptPaneProps,
  type ScriptPaneReadingPosition,
  type ScriptPaneReadingPositionBinding,
} from "./ScriptPane";
import { SCRIPT_TURNS } from "./scriptFixtures";

const fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
const elementFromPointDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "elementFromPoint",
);

function setup(
  position: ScriptPaneReadingPosition | null = null,
  strict = false,
  onUserScroll?: () => void,
  restore = true,
) {
  let captured: ScriptPaneReadingPosition | null = position;
  const binding: ScriptPaneReadingPositionBinding = {
    getPosition: () => captured,
    capture: (next) => {
      captured = next;
    },
    restore,
  };
  const props: ScriptPaneProps = {
    turns: SCRIPT_TURNS,
    readingPosition: binding,
    onUserScroll,
  };
  const tree = <ScriptPane {...props} />;
  const view = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  const body = view.container.querySelector<HTMLElement>(".sys-script-body");
  if (!body) throw new Error("Script body was not rendered");
  return {
    ...view,
    body,
    binding,
    captured: () => captured,
  };
}

function scriptGeometry(lineHeight = 20) {
  let currentLineHeight = lineHeight;
  let width = 200;
  let height = 200;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1200);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      if (this.classList.contains("sys-script-body"))
        return new DOMRect(0, 0, width, height);
      const body = this.closest<HTMLElement>(".sys-script-body");
      const index = Number(this.getAttribute("data-stop"));
      return new DOMRect(
        0,
        index * currentLineHeight - (body?.scrollTop ?? 0),
        100,
        16,
      );
    },
  );
  return {
    setLineHeight: (next: number) => (currentLineHeight = next),
    resize: (nextWidth: number, nextHeight: number) => {
      width = nextWidth;
      height = nextHeight;
    },
  };
}

describe("ScriptPane reading position", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (fontsDescriptor)
      Object.defineProperty(document, "fonts", fontsDescriptor);
    else Reflect.deleteProperty(document, "fonts");
    if (elementFromPointDescriptor)
      Object.defineProperty(
        document,
        "elementFromPoint",
        elementFromPointDescriptor,
      );
    else Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("restores the same word and pane-relative offset after geometry changes", () => {
    scriptGeometry();
    const { body } = setup({
      kind: "word",
      index: 30,
      offset: 24,
      fallbackTop: 0,
    });

    expect(body.scrollTop).toBe(576);
  });

  it("captures a visible word anchor and offset from a live user scroll", () => {
    scriptGeometry();
    const { body, captured } = setup(null, false, undefined, false);
    body.scrollTop = 600;
    fireEvent.wheel(body);
    fireEvent.scroll(body);

    expect(captured()).toEqual({
      kind: "word",
      index: 30,
      offset: 0,
      fallbackTop: 600,
      turns: SCRIPT_TURNS,
    });
  });

  it("uses a pixel position when the saved anchor is absent", () => {
    scriptGeometry();
    const { body } = setup({
      kind: "word",
      index: 99,
      offset: 8,
      fallbackTop: 510,
    });

    expect(body.scrollTop).toBe(510);
  });

  it("uses the saved pixel fallback when a transcript change reuses the paused word index", () => {
    const geometry = scriptGeometry();
    const { body, container, binding, captured, rerender } = setup();
    body.scrollTop = 590;
    fireEvent.wheel(body);
    fireEvent.scroll(body);
    const saved = captured();
    expect(saved).toMatchObject({
      kind: "word",
      index: 29,
      offset: -10,
      fallbackTop: 590,
    });
    expect(body.querySelector('[data-stop="29"]')).toHaveAttribute(
      "data-word-key",
      "episode:29",
    );
    const filtered = SCRIPT_TURNS.map((turn) => ({
      ...turn,
      words: turn.words
        .filter((word) => word.index !== 0)
        .map((word) => ({ ...word, index: word.index - 1 })),
    }));
    rerender(
      <ScriptPane
        turns={filtered}
        status={{ kind: "loading" }}
        readingPosition={binding}
      />,
    );
    geometry.setLineHeight(24);
    rerender(<ScriptPane turns={filtered} readingPosition={binding} />);

    const restored = container.querySelector<HTMLElement>(".sys-script-body");
    expect(restored?.querySelector('[data-stop="29"]')).toHaveAttribute(
      "data-word-key",
      "episode:30",
    );
    expect(restored?.scrollTop).toBe(590);
    expect(captured()).toBe(saved);
  });

  it("saves a manual return to a restore target after a mismatching scroll event", () => {
    scriptGeometry();
    stubResizeObserver();
    const onUserScroll = vi.fn();
    const { body, captured } = setup(
      { kind: "scroll", top: 400 },
      false,
      onUserScroll,
    );
    expect(body.scrollTop).toBe(400);
    fireEvent.wheel(body);
    body.scrollTop = 500;
    fireEvent.scroll(body);
    expect(captured()).toMatchObject({ kind: "word", fallbackTop: 500 });
    fireEvent.wheel(body);
    body.scrollTop = 400;
    fireEvent.scroll(body);
    expect(captured()).toMatchObject({ kind: "word", fallbackTop: 400 });
    expect(onUserScroll).toHaveBeenCalledTimes(2);
    body.scrollTop = 0;
    for (const observer of FakeResizeObserver.all) observer.fire(body);
    expect(body.scrollTop).toBe(400);
  });

  it("keeps the captured anchor when the browser rounds a restore target", () => {
    const geometry = scriptGeometry();
    stubResizeObserver();
    const onUserScroll = vi.fn();
    const { body, captured } = setup(null, false, onUserScroll);
    body.scrollTop = 590;
    fireEvent.wheel(body);
    fireEvent.scroll(body);
    const saved = captured();
    expect(saved).toMatchObject({ kind: "word", index: 29, offset: -10 });
    let top = body.scrollTop;
    Object.defineProperty(body, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.round(value);
      },
    });
    geometry.setLineHeight(20.25);
    for (const observer of FakeResizeObserver.all) observer.fire(body);
    expect(body.scrollTop).toBe(597);
    fireEvent.scroll(body);
    expect(captured()).toBe(saved);
    expect(onUserScroll).toHaveBeenCalledOnce();
    geometry.setLineHeight(24);
    for (const observer of FakeResizeObserver.all) observer.fire(body);
    expect(body.scrollTop).toBe(706);
  });

  it.each([false, true])(
    "preserves the reader's anchor across automatic geometry scroll with recent intent %s",
    (recentIntent) => {
      const geometry = scriptGeometry();
      stubResizeObserver();
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      const onUserScroll = vi.fn();
      const { body, captured } = setup(null, false, onUserScroll);
      body.scrollTop = 590;
      fireEvent.wheel(body);
      fireEvent.scroll(body);
      const saved = captured();
      expect(saved).toMatchObject({ kind: "word", index: 29, offset: -10 });
      clock.mockReturnValue(recentIntent ? 100 : 1000);
      geometry.setLineHeight(16);
      geometry.resize(760, 408);
      body.scrollTop = 0;
      fireEvent.scroll(body);
      expect(captured()).toBe(saved);
      for (const observer of FakeResizeObserver.all) observer.fire(body);
      expect(body.scrollTop).toBe(474);
      fireEvent.scroll(body);
      expect(captured()).toBe(saved);
      expect(onUserScroll).toHaveBeenCalledOnce();
    },
  );

  it("does not recapture a programmatic restore as user intent while wheel intent is armed", () => {
    const geometry = scriptGeometry();
    stubResizeObserver();
    const fonts = new EventTarget();
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fonts,
    });
    const onUserScroll = vi.fn();
    const { body, captured } = setup(
      { kind: "word", index: 20, offset: 12, fallbackTop: 388 },
      true,
      onUserScroll,
    );
    fireEvent.wheel(body);
    geometry.setLineHeight(22);
    act(() => {
      fonts.dispatchEvent(new Event("loadingdone"));
    });
    fireEvent.scroll(body);

    expect(body.scrollTop).toBe(428);
    expect(captured()).toEqual({
      kind: "word",
      index: 20,
      offset: 12,
      fallbackTop: 388,
    });
    expect(onUserScroll).not.toHaveBeenCalled();
    body.scrollTop = 500;
    fireEvent.scroll(body);
    expect(onUserScroll).toHaveBeenCalledOnce();
  });

  it("keeps the anchor offset after body and font reflow", () => {
    const geometry = scriptGeometry();
    stubResizeObserver();
    const fonts = new EventTarget();
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fonts,
    });
    const { body } = setup({
      kind: "word",
      index: 30,
      offset: 24,
      fallbackTop: 0,
    });
    geometry.setLineHeight(24);
    fonts.dispatchEvent(new Event("loadingdone"));
    for (const observer of FakeResizeObserver.all) observer.fire(body);

    expect(body.scrollTop).toBe(696);
    geometry.setLineHeight(28);
    for (const observer of FakeResizeObserver.all) observer.fire(body);
    expect(body.scrollTop).toBe(816);
  });

  it("keeps a selection edge-scroll place after release and a pane restore", () => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout"],
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      1200,
    );
    const rectOf = (element: HTMLElement) => {
      if (element.classList.contains("sys-script-body"))
        return new DOMRect(0, 0, 300, 200);
      const index = Number(element.dataset.stop);
      const reader = element.closest<HTMLElement>(".sys-script-body");
      return new DOMRect(
        (index % 5) * 60,
        Math.floor(index / 5) * 26 - (reader?.scrollTop ?? 0),
        50,
        20,
      );
    };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        return rectOf(this as HTMLElement);
      },
    );
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
      function (this: HTMLElement) {
        return [rectOf(this)] as unknown as DOMRectList;
      },
    );
    let captured: ScriptPaneReadingPosition | null = null;
    function ReadingHost() {
      const [shown, setShown] = useState(true);
      const [following, setFollowing] = useState(true);
      const readingPosition: ScriptPaneReadingPositionBinding = {
        getPosition: () => captured,
        capture: (position) => {
          captured = position;
        },
        restore: !following,
      };
      return (
        <>
          <button type="button" onClick={() => setShown(false)}>
            Hide script
          </button>
          <button type="button" onClick={() => setShown(true)}>
            Restore script
          </button>
          {shown ? (
            <ScriptPane
              turns={SCRIPT_TURNS}
              playing={0}
              following={following}
              onFollowChange={setFollowing}
              onSelect={() => undefined}
              onUserScroll={() => setFollowing(false)}
              onBackToPlayhead={() => setFollowing(true)}
              readingPosition={readingPosition}
            />
          ) : null}
        </>
      );
    }
    render(<ReadingHost />);
    const body = document.querySelector<HTMLElement>(".sys-script-body");
    const first = body?.querySelector<HTMLElement>('[data-stop="12"]');
    const selectedWord = body?.querySelector<HTMLElement>('[data-stop="15"]');
    if (!body || !first || !selectedWord)
      throw new Error("Expected the transcript words to render");
    let top = 0;
    Object.defineProperty(body, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.min(value, 60);
        fireEvent.scroll(body);
      },
    });
    document.elementFromPoint = (x, y) => {
      const column = Math.floor(x / 60);
      const row = Math.floor((y + top) / 26);
      if (x % 60 >= 50 || y % 26 >= 20 || column > 4) return null;
      return document.querySelector(`[data-stop="${row * 5 + column}"]`);
    };
    fireEvent.pointerDown(first, {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: 145,
      clientY: 62,
    });
    fireEvent.pointerMove(body, {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: 10,
      clientY: 190,
    });
    expect(body).toHaveAttribute("data-selecting");
    act(() => {
      for (let frame = 0; frame < 20; frame += 1) vi.advanceTimersByTime(16);
    });
    expect(body.scrollTop).toBe(60);
    fireEvent.pointerUp(body, {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: 10,
      clientY: 190,
    });
    expect(
      screen.getByRole("button", { name: "Back to playhead" }),
    ).toBeVisible();
    expect(selectedWord.textContent).toBe("sound");
    expect(selectedWord.getBoundingClientRect().top).toBe(18);

    fireEvent.click(screen.getByRole("button", { name: "Hide script" }));
    expect(document.querySelector(".sys-script-body")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore script" }));

    const restored = document.querySelector<HTMLElement>(".sys-script-body");
    const restoredWord =
      restored?.querySelector<HTMLElement>('[data-stop="15"]');
    expect(
      screen.getByRole("button", { name: "Back to playhead" }),
    ).toBeVisible();
    expect(restored?.scrollTop).toBe(60);
    expect(restoredWord?.textContent).toBe("sound");
    expect(restoredWord?.getBoundingClientRect().top).toBe(18);
  });

  it("keeps a paused End-focused word visible after font restoration", () => {
    const geometry = scriptGeometry();
    stubResizeObserver();
    const fonts = new EventTarget();
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fonts,
    });
    const nativeFocus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      nativeFocus.call(this, { preventScroll: true });
      if (options?.preventScroll || !this.classList.contains("sys-script-word"))
        return;
      const body = this.closest<HTMLElement>(".sys-script-body");
      if (!body) return;
      const rect = this.getBoundingClientRect();
      const pane = body.getBoundingClientRect();
      if (rect.bottom > pane.bottom)
        body.scrollTop += rect.bottom - pane.bottom;
      else if (rect.top < pane.top) body.scrollTop -= pane.top - rect.top;
    });
    const position: ScriptPaneReadingPosition = {
      kind: "word",
      index: 5,
      offset: 0,
      fallbackTop: 100,
    };
    const readingPosition: ScriptPaneReadingPositionBinding = {
      getPosition: () => position,
      capture: () => undefined,
      restore: true,
    };
    const { container } = render(
      <ScriptPane
        turns={SCRIPT_TURNS}
        readingPosition={readingPosition}
        following={false}
        onFollowChange={vi.fn()}
        onBackToPlayhead={vi.fn()}
        playing={0}
      />,
    );
    const body = container.querySelector<HTMLElement>(".sys-script-body");
    if (!body) throw new Error("Script body was not rendered");
    const firstWord = body.querySelector<HTMLElement>('[data-stop="0"]');
    const lastWord = body.querySelector<HTMLElement>('[data-stop="53"]');
    if (!firstWord || !lastWord)
      throw new Error("Expected the first and last words");
    firstWord.focus({ preventScroll: true });
    fireEvent.keyDown(firstWord, { key: "End" });

    expect(document.activeElement).toBe(lastWord);
    expect(body.scrollTop).toBe(876);
    expect(lastWord.getBoundingClientRect().top).toBe(184);
    expect(
      screen.getByRole("button", { name: "Back to playhead" }),
    ).toBeVisible();

    geometry.setLineHeight(24);
    act(() => fonts.dispatchEvent(new Event("loadingdone")));
    for (const observer of FakeResizeObserver.all) observer.fire(body);

    expect(document.activeElement).toBe(lastWord);
    expect(body.scrollTop).toBe(1088);
    expect(lastWord.getBoundingClientRect().top).toBe(184);
    expect(
      screen.getByRole("button", { name: "Back to playhead" }),
    ).toBeVisible();
  });

  it("clamps a pixel fallback to the pane's current scroll range", () => {
    scriptGeometry();
    const { body } = setup({ kind: "scroll", top: 3000 });

    expect(body.scrollTop).toBe(1000);
  });

  it("leaves a same-geometry location in place under StrictMode", () => {
    scriptGeometry();
    const { body } = setup(
      { kind: "word", index: 30, offset: 0, fallbackTop: 0 },
      true,
    );

    expect(body.scrollTop).toBe(600);
  });

  it("does not treat a programmatic Back to playhead scroll as manual after wheel input", () => {
    scriptGeometry();
    const onUserScroll = vi.fn();
    const ref = createRef<ScriptPaneHandle>();
    const readingPosition: ScriptPaneReadingPositionBinding = {
      getPosition: () => null,
      capture: vi.fn(),
      restore: true,
    };
    const { container } = render(
      <ScriptPane
        ref={ref}
        turns={SCRIPT_TURNS}
        following={false}
        onUserScroll={onUserScroll}
        readingPosition={readingPosition}
      />,
    );
    const body = container.querySelector<HTMLElement>(".sys-script-body");
    if (!body) throw new Error("Script body was not rendered");
    fireEvent.wheel(body);
    act(() => {
      ref.current?.scrollToWord(30, "center");
    });
    fireEvent.scroll(body);

    expect(onUserScroll).not.toHaveBeenCalled();
    expect(body.scrollTop).toBe(508);
    body.scrollTop = 600;
    fireEvent.scroll(body);
    expect(onUserScroll).toHaveBeenCalledOnce();
  });
});
