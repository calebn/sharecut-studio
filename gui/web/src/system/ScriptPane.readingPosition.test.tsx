import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
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
  let wordHeight = 16;
  let paneTop = 0;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    () => height,
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1200);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      if (this.classList.contains("sys-script-body"))
        return new DOMRect(0, paneTop, width, height);
      const body = this.closest<HTMLElement>(".sys-script-body");
      if (this instanceof HTMLElement && this.matches(".sys-handle")) {
        return new DOMRect(
          Number.parseFloat(this.style.insetInlineStart) - 10,
          paneTop +
            Number.parseFloat(this.style.insetBlockStart) -
            (body?.scrollTop ?? 0),
          20,
          16,
        );
      }
      const index = Number(this.getAttribute("data-stop"));
      return new DOMRect(
        0,
        paneTop + index * currentLineHeight - (body?.scrollTop ?? 0),
        100,
        wordHeight,
      );
    },
  );
  return {
    setLineHeight: (next: number) => (currentLineHeight = next),
    setWordHeight: (next: number) => (wordHeight = next),
    setPaneTop: (next: number) => (paneTop = next),
    resize: (nextWidth: number, nextHeight: number) => {
      width = nextWidth;
      height = nextHeight;
    },
  };
}

function stubNativeFocusScroll() {
  const nativeFocus: unknown = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "focus",
  )?.value;
  if (typeof nativeFocus !== "function")
    throw new Error("Expected native focus");
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    Reflect.apply(nativeFocus, this, [{ preventScroll: true }]);
    if (options?.preventScroll || !this.classList.contains("sys-script-word"))
      return;
    const body = this.closest<HTMLElement>(".sys-script-body");
    if (!body) return;
    const rect = this.getBoundingClientRect();
    const pane = body.getBoundingClientRect();
    if (rect.bottom > pane.bottom) body.scrollTop += rect.bottom - pane.bottom;
    else if (rect.top < pane.top) body.scrollTop -= pane.top - rect.top;
  });
}

function nestedScrollGeometry(paneTop: number) {
  let paneHeight = 400;
  let outerHeight = 600;
  let bodyPresent = true;
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const style = computedStyle(element);
    if (element.matches(".sys-script-body, .rv-main")) {
      style.overflowY = "auto";
      style.overflowX = "auto";
    }
    if (element.matches(".sys-script-word")) {
      style.outlineStyle = "solid";
      style.outlineWidth = "2px";
      style.outlineOffset = "2px";
    }
    return style;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches(".rv-main") ? outerHeight : paneHeight;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches(".rv-main") ? 300 : 260;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches(".rv-main")
        ? bodyPresent
          ? Math.max(outerHeight, paneTop - 40 + paneHeight + 120)
          : outerHeight
        : 1600;
    },
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      if (this.matches(".rv-main")) return new DOMRect(0, 40, 300, outerHeight);
      const outer = this.closest<HTMLElement>(".rv-main");
      if (this.hasAttribute("data-external-control"))
        return new DOMRect(20, 60 - (outer?.scrollTop ?? 0), 100, 24);
      const top = paneTop - (outer?.scrollTop ?? 0);
      if (this.matches(".sys-script-body"))
        return new DOMRect(20, top, 260, paneHeight);
      const body = this.closest<HTMLElement>(".sys-script-body");
      return new DOMRect(
        40,
        top +
          Number(this.getAttribute("data-stop")) * 20 -
          (body?.scrollTop ?? 0),
        100,
        16,
      );
    },
  );
  // JSDOM has no layout scrolling.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: function (
      this: HTMLElement,
      options?: boolean | ScrollIntoViewOptions,
    ) {
      for (let owner = this.parentElement; owner; owner = owner.parentElement) {
        if (!owner.matches(".sys-script-body, .rv-main")) continue;
        const target = this.getBoundingClientRect();
        const pane = owner.getBoundingClientRect();
        const center =
          typeof options === "object" && options.block === "center";
        const above = target.top < pane.top;
        const below = target.bottom > pane.bottom;
        const smaller = target.height <= pane.height;
        const delta = center
          ? (target.top + target.bottom - pane.top - pane.bottom) / 2
          : above && below
            ? 0
            : (above && smaller) || (below && !smaller)
              ? target.top - pane.top
              : (below && smaller) || (above && !smaller)
                ? target.bottom - pane.bottom
                : 0;
        owner.scrollTop = Math.max(
          0,
          Math.min(
            owner.scrollHeight - owner.clientHeight,
            owner.scrollTop + delta,
          ),
        );
      }
    },
  });
  const focus: unknown = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "focus",
  )?.value;
  if (typeof focus !== "function") throw new Error("Expected native focus");
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    Reflect.apply(focus, this, [{ preventScroll: true }]);
    if (!options?.preventScroll && this.matches(".sys-script-word"))
      this.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  return {
    setBodyPresent: (present: boolean, outer: HTMLElement) => {
      bodyPresent = present;
      outer.scrollTop = Math.min(
        outer.scrollTop,
        outer.scrollHeight - outer.clientHeight,
      );
    },
    shrink: () => {
      paneHeight = 180;
      outerHeight = 200;
    },
  };
}

describe("ScriptPane reading position", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (scrollIntoViewDescriptor)
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollIntoView",
        scrollIntoViewDescriptor,
      );
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
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

  it.each(["scroll-first", "observer-first"] as const)(
    "keeps the bottom reading anchor after a no-op wheel with %s delivery",
    (order) => {
      const geometry = scriptGeometry();
      stubResizeObserver();
      const onUserScroll = vi.fn();
      const { body, captured } = setup(null, false, onUserScroll);
      body.scrollTop = 950;
      fireEvent.wheel(body, { deltaY: 20 });
      fireEvent.scroll(body);
      const saved = captured();
      expect(saved).toMatchObject({
        kind: "word",
        index: 47,
        fallbackTop: 950,
      });

      geometry.resize(200, 408);
      body.scrollTop = body.scrollHeight - body.clientHeight;
      fireEvent.wheel(body, { deltaY: 20 });
      if (order === "observer-first")
        for (const observer of FakeResizeObserver.all) observer.fire(body);
      fireEvent.scroll(body);

      geometry.resize(200, 200);
      for (const observer of FakeResizeObserver.all) observer.fire(body);
      expect(body.scrollTop).toBe(950);
      expect(captured()).toMatchObject({
        kind: "word",
        index: 47,
        fallbackTop: 950,
      });
      expect(onUserScroll).toHaveBeenCalledOnce();
    },
  );

  it("keeps a touch scroll that arrives before the geometry observer", () => {
    const geometry = scriptGeometry();
    stubResizeObserver();
    const onUserScroll = vi.fn();
    const { body, captured } = setup(null, false, onUserScroll);
    body.scrollTop = 590;
    fireEvent.wheel(body, { deltaY: 20 });
    fireEvent.scroll(body);
    expect(captured()).toMatchObject({
      kind: "word",
      index: 29,
      fallbackTop: 590,
    });

    fireEvent.touchStart(body, {
      touches: [{ identifier: 1, target: body, clientX: 40, clientY: 160 }],
    });
    fireEvent.touchMove(body, {
      touches: [{ identifier: 1, target: body, clientX: 40, clientY: 80 }],
    });
    geometry.resize(200, 408);
    body.scrollTop = 670;
    fireEvent.touchEnd(body, {
      changedTouches: [
        { identifier: 1, target: body, clientX: 40, clientY: 80 },
      ],
    });
    fireEvent.scroll(body);

    geometry.resize(200, 200);
    for (const observer of FakeResizeObserver.all) observer.fire(body);
    expect(body.scrollTop).toBe(670);
    expect(captured()).toMatchObject({
      kind: "word",
      index: 33,
      fallbackTop: 670,
    });
    expect(onUserScroll).toHaveBeenCalledTimes(2);
  });

  it.each(["resize", "font", "layout"])(
    "accepts visible movement before the %s observation and notifies only once",
    (observation) => {
      const geometry = scriptGeometry();
      stubResizeObserver();
      const fonts = new EventTarget();
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: fonts,
      });
      const onUserScroll = vi.fn();
      const { body, binding, captured, rerender } = setup(
        null,
        false,
        onUserScroll,
      );
      body.scrollTop = 590;
      fireEvent.wheel(body);
      fireEvent.scroll(body);
      fireEvent.wheel(body, { deltaY: 80 });
      geometry.resize(201, 408);
      body.scrollTop = 670;
      if (observation === "resize") {
        for (const observer of FakeResizeObserver.all) observer.fire(body);
      } else if (observation === "font") {
        act(() => {
          fonts.dispatchEvent(new Event("loadingdone"));
        });
      } else {
        rerender(
          <ScriptPane
            turns={SCRIPT_TURNS}
            readingPosition={{ ...binding }}
            onUserScroll={onUserScroll}
          />,
        );
      }
      expect(body.scrollTop).toBe(670);
      expect(captured()).toMatchObject({
        kind: "word",
        index: 33,
        fallbackTop: 670,
      });
      expect(onUserScroll).toHaveBeenCalledTimes(2);
      const saved = captured();
      fireEvent.scroll(body);
      expect(captured()).toBe(saved);
      expect(onUserScroll).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps unobserved input through an unchanged geometry callback", () => {
    const geometry = scriptGeometry();
    stubResizeObserver();
    const onUserScroll = vi.fn();
    const { body, captured } = setup(null, false, onUserScroll);
    body.scrollTop = 590;
    fireEvent.wheel(body);
    fireEvent.scroll(body);
    fireEvent.wheel(body, { deltaY: 80 });
    for (const observer of FakeResizeObserver.all) observer.fire(body);
    geometry.resize(200, 408);
    body.scrollTop = 670;
    for (const observer of FakeResizeObserver.all) observer.fire(body);
    expect(body.scrollTop).toBe(670);
    expect(captured()).toMatchObject({
      kind: "word",
      index: 33,
      fallbackTop: 670,
    });
    fireEvent.scroll(body);
    expect(onUserScroll).toHaveBeenCalledTimes(2);
  });

  it.each([0, -20, 20])(
    "keeps earlier down movement after a later wheel delta %s",
    (lastDelta) => {
      const geometry = scriptGeometry();
      stubResizeObserver();
      const onUserScroll = vi.fn();
      const { body, captured } = setup(null, false, onUserScroll);
      body.scrollTop = 590;
      fireEvent.wheel(body);
      fireEvent.scroll(body);
      fireEvent.wheel(body, { deltaY: 80 });
      body.scrollTop = 650;
      fireEvent.wheel(body, { deltaY: 40 });
      geometry.resize(200, 408);
      body.scrollTop = 792;
      fireEvent.wheel(body, { deltaY: lastDelta });
      for (const observer of FakeResizeObserver.all) observer.fire(body);
      expect(body.scrollTop).toBe(792);
      expect(captured()).toMatchObject({
        kind: "word",
        index: 39,
        fallbackTop: 792,
      });
      fireEvent.scroll(body);
      expect(onUserScroll).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["wheel", "ended touch"])(
    "cancels the active contact without losing earlier %s movement",
    (earlier) => {
      const geometry = scriptGeometry();
      stubResizeObserver();
      const onUserScroll = vi.fn();
      const { body, captured } = setup(null, false, onUserScroll);
      body.scrollTop = 590;
      fireEvent.wheel(body);
      fireEvent.scroll(body);
      if (earlier === "wheel") fireEvent.wheel(body, { deltaY: 80 });
      else {
        fireEvent.touchStart(body, {
          touches: [{ identifier: 1, clientY: 160 }],
        });
        fireEvent.touchMove(body, {
          touches: [{ identifier: 1, clientY: 80 }],
        });
        fireEvent.touchEnd(body, {
          touches: [],
          changedTouches: [{ identifier: 1, clientY: 80 }],
        });
      }
      body.scrollTop = 650;
      fireEvent.touchStart(body, { touches: [{ identifier: 2, clientY: 80 }] });
      fireEvent.touchMove(body, { touches: [{ identifier: 2, clientY: 160 }] });
      fireEvent.touchCancel(body, {
        touches: [],
        changedTouches: [{ identifier: 2, clientY: 160 }],
      });
      geometry.resize(200, 408);
      body.scrollTop = 670;
      for (const observer of FakeResizeObserver.all) observer.fire(body);
      expect(body.scrollTop).toBe(670);
      expect(captured()).toMatchObject({
        kind: "word",
        index: 33,
        fallbackTop: 670,
      });
      fireEvent.scroll(body);
      expect(onUserScroll).toHaveBeenCalledTimes(2);
    },
  );

  it("discards movement supported only by a cancelled contact", () => {
    const geometry = scriptGeometry();
    stubResizeObserver();
    const { body, captured } = setup({ kind: "scroll", top: 590 });
    fireEvent.scroll(body);
    fireEvent.touchStart(body, { touches: [{ identifier: 1, clientY: 160 }] });
    fireEvent.touchMove(body, { touches: [{ identifier: 1, clientY: 80 }] });
    fireEvent.touchCancel(body, {
      touches: [],
      changedTouches: [{ identifier: 1, clientY: 80 }],
    });
    geometry.resize(200, 408);
    body.scrollTop = 670;
    for (const observer of FakeResizeObserver.all) observer.fire(body);
    expect(body.scrollTop).toBe(590);
    expect(captured()).toEqual({ kind: "scroll", top: 590 });
  });

  it.each(["key", "pointer"])(
    "does not renew an older extreme with weaker movement and generic %s intent",
    (renewal) => {
      const geometry = scriptGeometry();
      stubResizeObserver();
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      const onUserScroll = vi.fn();
      const { body, captured } = setup(
        { kind: "scroll", top: 590 },
        false,
        onUserScroll,
      );
      fireEvent.scroll(body);
      fireEvent.wheel(body, { deltaY: 80 });
      clock.mockReturnValue(500);
      body.scrollTop = 650;
      fireEvent.wheel(body, { deltaY: 20 });
      clock.mockReturnValue(650);
      if (renewal === "key") fireEvent.keyDown(body, { key: "PageDown" });
      else fireEvent.pointerDown(body, { pointerId: 1, pointerType: "mouse" });
      geometry.resize(200, 408);
      body.scrollTop = 670;
      for (const observer of FakeResizeObserver.all) observer.fire(body);
      expect(body.scrollTop).toBe(590);
      expect(captured()).toEqual({ kind: "scroll", top: 590 });
      expect(onUserScroll).not.toHaveBeenCalled();
    },
  );

  it.each(["body", "binding"])(
    "retires pending input with the %s",
    (retired) => {
      const geometry = scriptGeometry();
      stubResizeObserver();
      const { body, container, binding, captured, rerender } = setup({
        kind: "scroll",
        top: 590,
      });
      fireEvent.scroll(body);
      fireEvent.wheel(body, { deltaY: 80 });
      rerender(
        <ScriptPane
          turns={SCRIPT_TURNS}
          readingPosition={retired === "binding" ? undefined : binding}
          status={retired === "body" ? { kind: "loading" } : { kind: "ready" }}
        />,
      );
      rerender(<ScriptPane turns={SCRIPT_TURNS} readingPosition={binding} />);
      const current = container.querySelector<HTMLElement>(".sys-script-body");
      if (!current) throw new Error("Expected the current body");
      geometry.resize(200, 408);
      current.scrollTop = 670;
      for (const observer of FakeResizeObserver.all) observer.fire(current);
      expect(current.scrollTop).toBe(590);
      expect(captured()).toEqual({ kind: "scroll", top: 590 });
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
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(226);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(286);
    const rectOf = (element: HTMLElement) => {
      if (element.classList.contains("sys-script-body"))
        return new DOMRect(0, 0, 300, 226);
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
        top = Math.max(
          0,
          Math.min(value, body.scrollHeight - body.clientHeight),
        );
        fireEvent.scroll(body);
      },
    });
    document.elementFromPoint = (x, y) => {
      const column = Math.floor(x / 60);
      const row = Math.floor((y + top) / 26);
      if (x % 60 >= 50 || (y + top) % 26 >= 20 || column > 4) return null;
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

  it.each([false, true])(
    "keeps a paused End-focused word visible after font restoration with pending resize %s",
    (resized) => {
      const geometry = scriptGeometry();
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
        1600,
      );
      stubResizeObserver();
      const fonts = new EventTarget();
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: fonts,
      });
      stubNativeFocusScroll();
      let position: ScriptPaneReadingPosition = {
        kind: "word",
        index: 5,
        offset: 0,
        fallbackTop: 100,
      };
      const readingPosition: ScriptPaneReadingPositionBinding = {
        getPosition: () => position,
        capture: (next) => {
          position = next;
        },
        restore: true,
      };
      const onUserScroll = vi.fn();
      const { container } = render(
        <ScriptPane
          turns={SCRIPT_TURNS}
          readingPosition={readingPosition}
          following={false}
          onUserScroll={onUserScroll}
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
      fireEvent.wheel(body);
      fireEvent.keyDown(firstWord, { key: "End" });
      if (resized) geometry.resize(201, 200);
      fireEvent.scroll(body);
      expect(onUserScroll).not.toHaveBeenCalled();
      expect(position).toMatchObject({
        kind: "word",
        index: 53,
        intent: "focus",
      });

      expect(document.activeElement).toBe(lastWord);
      expect(body.scrollTop).toBe(876);
      expect(lastWord.getBoundingClientRect().top).toBe(184);
      expect(
        screen.getByRole("button", { name: "Back to playhead" }),
      ).toBeVisible();

      geometry.setLineHeight(24);
      act(() => {
        fonts.dispatchEvent(new Event("loadingdone"));
      });
      for (const observer of FakeResizeObserver.all) observer.fire(body);

      expect(document.activeElement).toBe(lastWord);
      expect(body.scrollTop).toBe(1088);
      expect(lastWord.getBoundingClientRect().top).toBe(184);
      expect(
        screen.getByRole("button", { name: "Back to playhead" }),
      ).toBeVisible();
    },
  );

  it.each(["font", "resize"])(
    "keeps a native Tab-focused word visible after %s restoration",
    async (callback) => {
      const user = userEvent.setup();
      const geometry = scriptGeometry();
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
        1600,
      );
      stubResizeObserver();
      const fonts = new EventTarget();
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: fonts,
      });
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      stubNativeFocusScroll();
      let position: ScriptPaneReadingPosition | null = null;
      const binding: ScriptPaneReadingPositionBinding = {
        getPosition: () => position,
        capture: (next) => {
          position = next;
        },
        restore: true,
      };
      const { container } = render(
        <ScriptPane
          turns={SCRIPT_TURNS}
          readingPosition={binding}
          following={false}
          playing={0}
          onFollowChange={vi.fn()}
          onBackToPlayhead={vi.fn()}
        />,
      );
      const body = container.querySelector<HTMLElement>(".sys-script-body");
      const word = body?.querySelector<HTMLElement>('[data-stop="5"]');
      if (!body || !word) throw new Error("Expected the remembered word");
      await act(async () => {
        word.focus();
      });
      await act(async () => {
        screen.getByRole("button", { name: "Follow the playhead" }).focus();
      });
      body.scrollTop = 600;
      fireEvent.wheel(body);
      fireEvent.scroll(body);
      expect(position).toMatchObject({
        kind: "word",
        index: 30,
        fallbackTop: 600,
      });
      clock.mockReturnValue(1000);
      await user.tab();
      await act(async () => {
        await Promise.resolve();
      });
      fireEvent.scroll(body);
      expect(document.activeElement).toBe(word);
      expect(word.textContent).toBe("Today");
      expect(body.scrollTop).toBe(100);
      expect(word.getBoundingClientRect().top).toBe(0);
      geometry.setLineHeight(24);
      await act(async () => {
        if (callback === "font") fonts.dispatchEvent(new Event("loadingdone"));
        else for (const observer of FakeResizeObserver.all) observer.fire(body);
      });
      expect(document.activeElement).toBe(word);
      expect.soft(body.scrollTop).toBe(120);
      expect.soft(word.getBoundingClientRect().top).toBe(0);
      expect(position).toMatchObject({
        kind: "word",
        index: 5,
        fallbackTop: 100,
      });
    },
  );

  it.each(["font", "resize"])(
    "keeps a held edge selection viewport and endpoint through %s restoration",
    (callback) => {
      vi.useFakeTimers({
        toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout"],
      });
      stubResizeObserver();
      const fonts = new EventTarget();
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: fonts,
      });
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
        226,
      );
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
        286,
      );
      const rectOf = (element: Element) => {
        if (element.classList.contains("sys-script-body"))
          return new DOMRect(0, 0, 300, 226);
        const index = Number(element.getAttribute("data-stop"));
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
          return rectOf(this);
        },
      );
      vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
        function (this: HTMLElement) {
          return [rectOf(this)] as unknown as DOMRectList;
        },
      );
      let position: ScriptPaneReadingPosition | null = {
        kind: "scroll",
        top: 20,
      };
      const binding: ScriptPaneReadingPositionBinding = {
        getPosition: () => position,
        capture: (next) => {
          position = next;
        },
        restore: true,
      };
      const onSelect = vi.fn();
      const onSelectionEnd = vi.fn();
      const onUserScroll = vi.fn();
      const { container } = render(
        <ScriptPane
          turns={SCRIPT_TURNS}
          following={false}
          readingPosition={binding}
          onSelect={onSelect}
          onSelectionEnd={onSelectionEnd}
          onUserScroll={onUserScroll}
        />,
      );
      const body = container.querySelector<HTMLElement>(".sys-script-body");
      const first = body?.querySelector<HTMLElement>('[data-stop="12"]');
      if (!body || !first) throw new Error("Expected selection words");
      let top = body.scrollTop;
      Object.defineProperty(body, "scrollTop", {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = Math.max(
            0,
            Math.min(value, body.scrollHeight - body.clientHeight),
          );
        },
      });
      document.elementFromPoint = (x, y) => {
        const column = Math.floor(x / 60);
        const row = Math.floor((y + top) / 26);
        if (x % 60 >= 50 || (y + top) % 26 >= 20 || column > 4) return null;
        return body.querySelector(`[data-stop="${row * 5 + column}"]`);
      };
      fireEvent.pointerDown(first, {
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        clientX: 145,
        clientY: 42,
      });
      fireEvent.pointerMove(body, {
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        clientX: 10,
        clientY: 190,
      });
      act(() => {
        for (let frame = 0; frame < 20; frame += 1) vi.advanceTimersByTime(16);
      });
      fireEvent.scroll(body);
      expect(body).toHaveAttribute("data-selecting");
      expect(body.scrollTop).toBe(60);
      expect(document.elementFromPoint(10, 190)?.textContent).toBe("So,");
      expect(onSelect).not.toHaveBeenCalled();
      act(() => {
        if (callback === "font") fonts.dispatchEvent(new Event("loadingdone"));
        else for (const observer of FakeResizeObserver.all) observer.fire(body);
      });
      expect.soft(body.scrollTop).toBe(60);
      expect.soft(position).toMatchObject({ kind: "word", fallbackTop: 60 });
      fireEvent.pointerUp(body, {
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        clientX: 10,
        clientY: 190,
      });
      expect(onSelect).toHaveBeenCalledExactlyOnceWith({
        kind: "words",
        anchor: 12,
        head: 45,
      });
      expect(onSelectionEnd).toHaveBeenCalledExactlyOnceWith(12, 45, {
        source: "mouse",
        intent: "drag",
        shift: false,
        alt: false,
        mod: false,
        committed: true,
      });
      expect(onUserScroll).toHaveBeenCalledOnce();
      expect(body).not.toHaveAttribute("data-selecting");
    },
  );

  it.each(["font", "resize"])(
    "fits the native Tab anchor after height-only %s restoration without stealing a wheel anchor",
    async (callback) => {
      const user = userEvent.setup();
      const geometry = scriptGeometry();
      geometry.resize(200, 400);
      geometry.setPaneTop(80);
      stubResizeObserver();
      stubNativeFocusScroll();
      const fonts = new EventTarget();
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: fonts,
      });
      vi.stubGlobal("innerHeight", 500);
      const { body, binding, captured, rerender } = setup();
      rerender(
        <ScriptPane
          turns={SCRIPT_TURNS}
          readingPosition={binding}
          following={false}
          onFollowChange={vi.fn()}
        />,
      );
      const word = body.querySelector<HTMLElement>('[data-stop="15"]');
      if (!word) throw new Error("Expected remembered Tab word");
      await act(async () => {
        word.focus();
      });
      await act(async () => {
        screen.getByRole("button", { name: "Follow the playhead" }).focus();
      });
      await user.tab();
      expect(document.activeElement).toBe(word);
      expect(captured()).toMatchObject({
        kind: "word",
        index: 15,
        offset: 300,
        fallbackTop: 0,
      });
      const restore = () => {
        if (callback === "font") fonts.dispatchEvent(new Event("loadingdone"));
        else for (const observer of FakeResizeObserver.all) observer.fire(body);
      };
      geometry.resize(200, 180);
      vi.stubGlobal("innerHeight", 240);
      act(restore);
      expect.soft(body.scrollTop).toBe(156);
      expect.soft(word.getBoundingClientRect().top).toBe(224);
      expect.soft(word.getBoundingClientRect().bottom).toBe(240);
      expect(document.activeElement).toBe(word);

      vi.stubGlobal("innerHeight", 400);
      act(restore);
      expect.soft(body.scrollTop).toBe(156);
      expect.soft(word.getBoundingClientRect().top).toBe(224);
      expect.soft(word.getBoundingClientRect().bottom).toBe(240);

      geometry.setWordHeight(32);
      act(restore);
      expect.soft(body.scrollTop).toBe(156);
      expect.soft(word.getBoundingClientRect().bottom).toBe(256);
      expect(document.activeElement).toBe(word);

      geometry.setWordHeight(16);
      body.scrollTop = 600;
      fireEvent.wheel(body);
      fireEvent.scroll(body);
      expect(captured()).toMatchObject({ kind: "word", index: 30, offset: 0 });
      geometry.resize(200, 120);
      act(restore);
      expect(body.scrollTop).toBe(600);
      expect(document.activeElement).toBe(word);
      expect(
        body.querySelector('[data-stop="30"]')?.getBoundingClientRect().top,
      ).toBe(80);
    },
  );

  it.each([
    [60, "resize", 10],
    [60, "font", 10],
    [80, "resize", 30],
    [80, "font", 30],
    [300, "resize", 250],
    [300, "font", 250],
  ] as const)(
    "reveals the full Tab anchor and ring across nested scrollports at %i after %s",
    async (paneTop, callback, expectedOuterTop) => {
      const user = userEvent.setup();
      const geometry = nestedScrollGeometry(paneTop);
      stubResizeObserver();
      vi.stubGlobal("innerHeight", 800);
      const fonts = new EventTarget();
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: fonts,
      });
      let position: ScriptPaneReadingPosition | null = null;
      const binding: ScriptPaneReadingPositionBinding = {
        getPosition: () => position,
        capture: (next) => {
          position = next;
        },
        restore: true,
      };
      const onUserScroll = vi.fn();
      const { container } = render(
        <div className="rv-main">
          <ScriptPane
            turns={SCRIPT_TURNS}
            following={false}
            readingPosition={binding}
            onFollowChange={vi.fn()}
            onUserScroll={onUserScroll}
          />
        </div>,
      );
      const body = container.querySelector<HTMLElement>(".sys-script-body");
      const outer = container.querySelector<HTMLElement>(".rv-main");
      const word = body?.querySelector<HTMLElement>('[data-stop="15"]');
      if (!body || !outer || !word)
        throw new Error("Expected nested reading pane");
      await act(async () => {
        word.focus();
      });
      await act(async () => {
        screen.getByRole("button", { name: "Follow the playhead" }).focus();
      });
      await user.tab();
      expect(document.activeElement).toBe(word);
      expect(position).toMatchObject({ kind: "word", index: 15, offset: 300 });
      const saved = position;
      const restore = () => {
        if (callback === "font") fonts.dispatchEvent(new Event("loadingdone"));
        else for (const observer of FakeResizeObserver.all) observer.fire(body);
      };
      act(restore);
      expect(position).toBe(saved);
      expect(body.scrollTop).toBe(0);
      expect(outer.scrollTop).toBe(0);
      geometry.shrink();
      vi.stubGlobal("innerHeight", 500);
      fireEvent.wheel(body);
      act(restore);
      fireEvent.scroll(body);
      fireEvent.scroll(outer);
      const style = getComputedStyle(word);
      const ring =
        Number.parseFloat(style.outlineWidth) +
        Number.parseFloat(style.outlineOffset);
      expect(ring).toBe(4);
      expect.soft(word.getBoundingClientRect().top - ring).toBe(128);
      expect.soft(word.getBoundingClientRect().bottom + ring).toBe(152);
      expect.soft(body.scrollTop).toBe(218);
      expect.soft(outer.scrollTop).toBe(expectedOuterTop);
      const visibleTop = Math.max(
        0,
        body.getBoundingClientRect().top,
        outer.getBoundingClientRect().top,
      );
      const visibleBottom = Math.min(
        innerHeight,
        body.getBoundingClientRect().bottom,
        outer.getBoundingClientRect().bottom,
      );
      expect
        .soft(word.getBoundingClientRect().top - ring)
        .toBeGreaterThanOrEqual(visibleTop);
      expect
        .soft(word.getBoundingClientRect().bottom + ring)
        .toBeLessThanOrEqual(visibleBottom);
      expect(word.getBoundingClientRect().left - ring).toBeGreaterThanOrEqual(
        20,
      );
      expect(word.getBoundingClientRect().right + ring).toBeLessThanOrEqual(
        280,
      );
      expect(document.activeElement).toBe(word);
      expect(position).toMatchObject({
        kind: "word",
        index: 15,
        offset: 82,
        fallbackTop: 218,
      });
      expect(onUserScroll).not.toHaveBeenCalled();

      body.scrollTop = 600;
      fireEvent.wheel(body);
      fireEvent.scroll(body);
      expect(position).toMatchObject({
        kind: "word",
        index: 30,
        offset: 0,
        fallbackTop: 600,
      });
      act(restore);
      expect(body.scrollTop).toBe(600);
      expect(outer.scrollTop).toBe(expectedOuterTop);
      expect(document.activeElement).toBe(word);
      expect(onUserScroll).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["font", "before"],
    ["resize", "before"],
    ["font", "after"],
    ["resize", "after"],
  ] as const)(
    "preserves a manually partial still-focused word after %s with scroll delivered %s resize and accepts fresh Tab ownership",
    async (callback, scrollOrder) => {
      const user = userEvent.setup();
      const geometry = scriptGeometry();
      stubNativeFocusScroll();
      stubResizeObserver();
      const fonts = new EventTarget();
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: fonts,
      });
      let position: ScriptPaneReadingPosition | null = null;
      const binding: ScriptPaneReadingPositionBinding = {
        getPosition: () => position,
        capture: (next) => {
          position = next;
        },
        restore: true,
      };
      const onUserScroll = vi.fn();
      const { container } = render(
        <ScriptPane
          turns={SCRIPT_TURNS}
          following={false}
          readingPosition={binding}
          onFollowChange={vi.fn()}
          onUserScroll={onUserScroll}
        />,
      );
      const body = container.querySelector<HTMLElement>(".sys-script-body");
      const word = body?.querySelector<HTMLElement>('[data-stop="0"]');
      if (!body || !word) throw new Error("Expected first reading word");
      let scrollTop = 0;
      Object.defineProperty(body, "scrollTop", {
        configurable: true,
        get: () => scrollTop,
        set: (next: number) => {
          scrollTop = Math.max(
            0,
            Math.min(body.scrollHeight - body.clientHeight, next),
          );
        },
      });
      const follow = screen.getByRole("button", {
        name: "Follow the playhead",
      });
      act(() => {
        follow.focus();
      });
      await user.tab();
      expect(document.activeElement).toBe(word);
      expect(position).toMatchObject({ kind: "word", index: 0, offset: 0 });

      fireEvent.wheel(body, { deltaY: 10 });
      body.scrollTop = 10;
      if (scrollOrder === "after") geometry.resize(200, 199);
      fireEvent.scroll(body);
      expect(position).toMatchObject({
        kind: "word",
        index: 0,
        offset: -10,
        fallbackTop: 10,
      });
      expect(document.activeElement).toBe(word);
      const manual = position;
      geometry.resize(200, 199);
      const settle = () => {
        if (callback === "font") fonts.dispatchEvent(new Event("loadingdone"));
        else for (const observer of FakeResizeObserver.all) observer.fire(body);
      };
      act(settle);
      expect.soft(body.scrollTop).toBe(10);
      expect.soft(word.getBoundingClientRect().top).toBe(-10);
      expect.soft(position).toBe(manual);
      expect(document.activeElement).toBe(word);
      expect(onUserScroll).toHaveBeenCalledOnce();

      act(() => {
        follow.focus();
      });
      await user.tab();
      expect(document.activeElement).toBe(word);
      expect(body.scrollTop).toBe(0);
      expect(word.getBoundingClientRect().top).toBe(0);
      expect(position).toMatchObject({ kind: "word", index: 0, offset: 0 });
      act(settle);
      expect(word.getBoundingClientRect().top).toBe(0);
      expect(word.getBoundingClientRect().bottom).toBe(16);
      expect(onUserScroll).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["unmount", false, "document"],
    ["unmount", true, "document"],
    ["loading", false, "document"],
    ["loading", true, "document"],
    ["unmount", false, "ancestor"],
    ["unmount", true, "ancestor"],
    ["loading", false, "ancestor"],
    ["loading", true, "ancestor"],
  ] as const)(
    "reveals the returning reading region after %s with StrictMode %s, %s focus and ancestor clamp",
    async (transition, strict, focusOwner) => {
      const geometry = nestedScrollGeometry(300);
      stubResizeObserver();
      vi.stubGlobal("innerHeight", 800);
      let position: ScriptPaneReadingPosition | null = null;
      const binding: ScriptPaneReadingPositionBinding = {
        getPosition: () => position,
        capture: (next) => {
          position = next;
        },
        restore: true,
      };
      const onUserScroll = vi.fn();
      const tree = (shown: boolean) => {
        const pane = (
          <div tabIndex={-1} data-stage-fallback="">
            <div className="rv-main">
              {shown || transition === "loading" ? (
                <ScriptPane
                  turns={SCRIPT_TURNS}
                  status={shown ? { kind: "ready" } : { kind: "loading" }}
                  following={false}
                  readingPosition={binding}
                  onUserScroll={onUserScroll}
                />
              ) : (
                <p>Script hidden at short height</p>
              )}
            </div>
          </div>
        );
        return strict ? <StrictMode>{pane}</StrictMode> : pane;
      };
      const { container, rerender } = render(tree(true));
      const outer = container.querySelector<HTMLElement>(".rv-main");
      const body = container.querySelector<HTMLElement>(".sys-script-body");
      const word = body?.querySelector<HTMLElement>('[data-stop="15"]');
      if (!outer || !body || !word) throw new Error("Expected nested reader");
      await act(async () => {
        word.focus();
      });
      geometry.shrink();
      act(() => {
        for (const observer of FakeResizeObserver.all) observer.fire(body);
      });
      expect(body.scrollTop).toBe(218);
      expect(outer.scrollTop).toBe(250);
      expect(position).toMatchObject({ kind: "word", index: 15, offset: 82 });
      const saved = position;
      if (transition === "loading") {
        await act(async () => {
          word.blur();
        });
      }
      rerender(tree(false));
      geometry.setBodyPresent(false, outer);
      expect(outer.scrollTop).toBe(0);
      expect(document.activeElement).toBe(document.body);
      const ancestor = container.querySelector<HTMLElement>(
        "[data-stage-fallback]",
      );
      if (!ancestor) throw new Error("Expected persistent stage ancestor");
      if (focusOwner === "ancestor") {
        act(() => ancestor.focus({ preventScroll: true }));
      }
      const retiredFocus = document.activeElement;
      geometry.setBodyPresent(true, outer);
      rerender(tree(true));
      const restored = container.querySelector<HTMLElement>(".sys-script-body");
      const restoredWord =
        restored?.querySelector<HTMLElement>('[data-stop="15"]');
      if (!restored || !restoredWord)
        throw new Error("Expected restored reader");
      expect(restored.scrollTop).toBe(218);
      expect(
        restoredWord.getBoundingClientRect().top -
          restored.getBoundingClientRect().top,
      ).toBe(82);
      expect.soft(outer.scrollTop).toBe(240);
      expect.soft(restored.getBoundingClientRect().top).toBe(60);
      expect.soft(restored.getBoundingClientRect().bottom).toBe(240);
      expect
        .soft(restored.getBoundingClientRect().top)
        .toBeGreaterThanOrEqual(outer.getBoundingClientRect().top);
      expect
        .soft(restored.getBoundingClientRect().bottom)
        .toBeLessThanOrEqual(outer.getBoundingClientRect().bottom);
      expect(position).toBe(saved);
      expect(document.activeElement).toBe(retiredFocus);
      fireEvent.scroll(restored);
      expect(onUserScroll).not.toHaveBeenCalled();
      rerender(tree(true));
      expect.soft(outer.scrollTop).toBe(240);
      expect(restored.scrollTop).toBe(218);
    },
  );

  it.each(["input", "button"] as const)(
    "leaves a persistent external %s in control when the reader returns",
    async (control) => {
      const geometry = nestedScrollGeometry(300);
      geometry.shrink();
      const position: ScriptPaneReadingPosition = {
        kind: "word",
        index: 15,
        offset: 82,
        fallbackTop: 218,
      };
      let saved: ScriptPaneReadingPosition = position;
      const binding: ScriptPaneReadingPositionBinding = {
        getPosition: () => saved,
        capture: (next) => {
          saved = next;
        },
        restore: true,
      };
      const tree = (shown: boolean) => (
        <div className="rv-main">
          {control === "input" ? (
            <input aria-label="Outside control" data-external-control="" />
          ) : (
            <button type="button" data-external-control="">
              Outside control
            </button>
          )}
          {shown ? (
            <ScriptPane
              turns={SCRIPT_TURNS}
              following={false}
              readingPosition={binding}
            />
          ) : null}
        </div>
      );
      const { container, rerender } = render(tree(false));
      const outer = container.querySelector<HTMLElement>(".rv-main");
      if (!outer) throw new Error("Expected outer scroller");
      const outside = screen.getByRole(
        control === "input" ? "textbox" : "button",
        { name: "Outside control" },
      );
      await act(async () => {
        outside.focus();
      });
      expect(outside.getBoundingClientRect().top).toBe(60);
      expect(outside.getBoundingClientRect().bottom).toBe(84);
      rerender(tree(true));
      const body = container.querySelector<HTMLElement>(".sys-script-body");
      expect(body?.scrollTop).toBe(218);
      expect(outer.scrollTop).toBe(0);
      expect(outside.getBoundingClientRect().top).toBe(60);
      expect(outside.getBoundingClientRect().bottom).toBe(84);
      expect(document.activeElement).toBe(outside);
      expect(saved).toBe(position);
    },
  );

  it.each(["no bookmark", "following", "unbound Edit"] as const)(
    "does not reveal a returning region for %s",
    (mode) => {
      const geometry = nestedScrollGeometry(300);
      geometry.shrink();
      let position: ScriptPaneReadingPosition | null =
        mode === "no bookmark"
          ? null
          : { kind: "word", index: 15, offset: 82, fallbackTop: 218 };
      const binding: ScriptPaneReadingPositionBinding = {
        getPosition: () => position,
        capture: (next) => {
          position = next;
        },
        restore: mode !== "following",
      };
      const tree = (shown: boolean) => (
        <div className="rv-main">
          {shown ? (
            <ScriptPane
              turns={SCRIPT_TURNS}
              following={mode === "following"}
              readingPosition={mode === "unbound Edit" ? undefined : binding}
            />
          ) : null}
        </div>
      );
      const { container, rerender } = render(tree(false));
      rerender(tree(true));
      const outer = container.querySelector<HTMLElement>(".rv-main");
      const body = container.querySelector<HTMLElement>(".sys-script-body");
      expect(body?.scrollTop).toBe(0);
      expect(outer?.scrollTop).toBe(0);
      expect(body?.getBoundingClientRect().top).toBe(300);
      expect(document.activeElement).toBe(document.body);
    },
  );

  it("does not return a mounted reading region to view on selection, binding, font or resize updates", () => {
    const geometry = nestedScrollGeometry(300);
    geometry.shrink();
    stubResizeObserver();
    const fonts = new EventTarget();
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fonts,
    });
    let position: ScriptPaneReadingPosition | null = null;
    const binding: ScriptPaneReadingPositionBinding = {
      getPosition: () => position,
      capture: (next) => {
        position = next;
      },
      restore: true,
    };
    const tree = (selected: boolean) => (
      <div className="rv-main">
        <ScriptPane
          turns={SCRIPT_TURNS}
          following={false}
          readingPosition={{ ...binding }}
          selection={selected ? { kind: "words", anchor: 15, head: 16 } : null}
        />
      </div>
    );
    const { container, rerender } = render(tree(false));
    const body = container.querySelector<HTMLElement>(".sys-script-body");
    const outer = container.querySelector<HTMLElement>(".rv-main");
    if (!body || !outer) throw new Error("Expected mounted reader");
    fireEvent.wheel(body, { deltaY: 218 });
    body.scrollTop = 218;
    fireEvent.scroll(body);
    expect(position).toMatchObject({ kind: "word", index: 11, offset: 2 });
    rerender(tree(true));
    act(() => {
      fonts.dispatchEvent(new Event("loadingdone"));
      for (const observer of FakeResizeObserver.all) observer.fire(body);
    });
    expect(outer.scrollTop).toBe(0);
    expect(body.scrollTop).toBe(218);
    expect(body.getBoundingClientRect().top).toBe(300);
    expect(document.activeElement).toBe(document.body);
  });

  it.each(["pane", "ancestor"] as const)(
    "keeps the accepted %s fit after short-height unmount without refocusing",
    async (owner) => {
      const user = userEvent.setup();
      const nested = owner === "ancestor" ? nestedScrollGeometry(300) : null;
      const pane = owner === "pane" ? scriptGeometry() : null;
      if (pane) {
        pane.resize(200, 400);
        pane.setPaneTop(80);
        stubNativeFocusScroll();
      }
      stubResizeObserver();
      vi.stubGlobal("innerHeight", 800);
      let position: ScriptPaneReadingPosition | null = null;
      const binding: ScriptPaneReadingPositionBinding = {
        getPosition: () => position,
        capture: (next) => {
          position = next;
        },
        restore: true,
      };
      const onUserScroll = vi.fn();
      const tree = (shown: boolean) => (
        <div className="rv-main">
          {shown ? (
            <ScriptPane
              turns={SCRIPT_TURNS}
              following={false}
              onFollowChange={vi.fn()}
              onUserScroll={onUserScroll}
              readingPosition={binding}
            />
          ) : (
            <p>Script hidden at short height</p>
          )}
        </div>
      );
      const { container, rerender } = render(tree(true));
      const body = container.querySelector<HTMLElement>(".sys-script-body");
      const word = body?.querySelector<HTMLElement>('[data-stop="15"]');
      if (!body || !word) throw new Error("Expected remembered word");
      await act(async () => {
        word.focus();
      });
      await act(async () => {
        screen.getByRole("button", { name: "Follow the playhead" }).focus();
      });
      await user.tab();
      expect(document.activeElement).toBe(word);
      expect(position).toMatchObject({ kind: "word", index: 15, offset: 300 });
      nested?.shrink();
      pane?.resize(200, 180);
      vi.stubGlobal("innerHeight", owner === "pane" ? 240 : 500);
      fireEvent.wheel(body);
      act(() => {
        for (const observer of FakeResizeObserver.all) observer.fire(body);
      });
      fireEvent.scroll(body);
      const expectedOffset = owner === "pane" ? 144 : 82;
      const expectedTop = owner === "pane" ? 156 : 218;
      expect(
        word.getBoundingClientRect().top - body.getBoundingClientRect().top,
      ).toBe(expectedOffset);
      expect(body.scrollTop).toBe(expectedTop);
      expect.soft(position).toMatchObject({
        kind: "word",
        index: 15,
        offset: expectedOffset,
        fallbackTop: expectedTop,
      });
      expect(onUserScroll).not.toHaveBeenCalled();
      vi.stubGlobal("innerHeight", 100);
      rerender(tree(false));
      expect(container.querySelector(".sys-script-body")).toBeNull();
      expect(document.activeElement).toBe(document.body);
      vi.stubGlobal("innerHeight", owner === "pane" ? 240 : 500);
      rerender(tree(true));
      const restored = container.querySelector<HTMLElement>(".sys-script-body");
      const restoredWord =
        restored?.querySelector<HTMLElement>('[data-stop="15"]');
      if (!restored || !restoredWord) throw new Error("Expected restored word");
      expect(restoredWord.textContent).toBe("sound");
      expect.soft(restored.scrollTop).toBe(expectedTop);
      const rect = restoredWord.getBoundingClientRect();
      const bounds = restored.getBoundingClientRect();
      expect.soft(rect.top - bounds.top).toBe(expectedOffset);
      expect.soft(rect.top).toBe(owner === "pane" ? 224 : 132);
      expect.soft(rect.bottom).toBe(owner === "pane" ? 240 : 148);
      expect.soft(rect.top).toBeGreaterThanOrEqual(bounds.top);
      expect
        .soft(rect.bottom)
        .toBeLessThanOrEqual(Math.min(bounds.bottom, innerHeight));
      expect(document.activeElement).toBe(document.body);
      expect(onUserScroll).not.toHaveBeenCalled();
    },
  );

  it.each(["start", "end"] as const)(
    "keeps manual reading after a %s grip completes without restoration while held",
    async (edge) => {
      const geometry = scriptGeometry();
      stubNativeFocusScroll();
      stubResizeObserver();
      vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
        function (this: HTMLElement) {
          return [this.getBoundingClientRect()] as unknown as DOMRectList;
        },
      );
      const fonts = new EventTarget();
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: fonts,
      });
      let position: ScriptPaneReadingPosition | null = null;
      const binding: ScriptPaneReadingPositionBinding = {
        getPosition: () => position,
        capture: (next) => {
          position = next;
        },
        restore: true,
      };
      const onSelect = vi.fn();
      function Host() {
        const [selection, setSelection] =
          useState<ScriptPaneProps["selection"]>(null);
        return (
          <ScriptPane
            turns={SCRIPT_TURNS}
            following={false}
            readingPosition={binding}
            handles
            selection={selection}
            onSelect={(next) => {
              onSelect(next);
              setSelection(next);
            }}
          />
        );
      }
      const { container } = render(<Host />);
      const body = container.querySelector<HTMLElement>(".sys-script-body");
      const word = body?.querySelector<HTMLElement>('[data-stop="8"]');
      const focused = body?.querySelector<HTMLElement>('[data-stop="9"]');
      if (!body || !word || !focused) throw new Error("Expected reading words");
      await act(async () => word.focus());
      fireEvent.keyDown(word, { key: "ArrowRight", shiftKey: true });
      expect(document.activeElement).toBe(focused);
      expect(position).toMatchObject({
        kind: "word",
        index: 9,
        intent: "focus",
        offset: 180,
      });
      expect(onSelect).toHaveBeenLastCalledWith({
        kind: "words",
        anchor: 8,
        head: 9,
      });
      const grip = body.querySelector<HTMLElement>(`[data-edge="${edge}"]`);
      if (!grip) throw new Error("Expected selection grip");
      const rect = grip.getBoundingClientRect();
      grip.setPointerCapture = vi.fn();
      const pointer = {
        pointerId: 7,
        pointerType: "touch",
        isPrimary: true,
        clientX: rect.left + rect.width / 2,
      };
      fireEvent.pointerDown(grip, { ...pointer, clientY: rect.top + 8 });
      fireEvent.pointerMove(grip, {
        ...pointer,
        clientY: edge === "start" ? 128 : 208,
      });
      fireEvent.pointerUp(grip, {
        ...pointer,
        clientY: edge === "start" ? 128 : 208,
      });
      expect(onSelect).toHaveBeenLastCalledWith(
        edge === "start"
          ? { kind: "words", anchor: 6, head: 9 }
          : { kind: "words", anchor: 8, head: 10 },
      );
      expect(document.activeElement).toBe(focused);
      expect(body.scrollTop).toBe(0);
      geometry.resize(200, 100);
      act(() => {
        fonts.dispatchEvent(new Event("loadingdone"));
        for (const observer of FakeResizeObserver.all) observer.fire(body);
      });
      expect(body.scrollTop).toBe(0);
      expect(position).toMatchObject({
        kind: "word",
        index: 0,
        offset: 0,
        fallbackTop: 0,
      });
      expect(position).not.toHaveProperty("intent");
      expect(document.activeElement).toBe(focused);
    },
  );

  it.each(["start", "end"] as const)(
    "yields to an accepted %s grip through reflow and releases ownership on every exit",
    (edge) => {
      vi.useFakeTimers({
        toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
      });
      stubResizeObserver();
      const fonts = new EventTarget();
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: fonts,
      });
      let addedHeight = 0;
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
        200,
      );
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
        () => 1200 + addedHeight,
      );
      const rectOf = (element: Element): DOMRect => {
        if (element.classList.contains("sys-script-body"))
          return new DOMRect(0, 0, 200, 200);
        const body = element.closest<HTMLElement>(".sys-script-body");
        if (
          element instanceof HTMLElement &&
          element.classList.contains("sys-handle")
        ) {
          return new DOMRect(
            Number.parseFloat(element.style.insetInlineStart) - 10,
            Number.parseFloat(element.style.insetBlockStart) -
              (body?.scrollTop ?? 0),
            20,
            16,
          );
        }
        const index = Number(element.getAttribute("data-stop"));
        return new DOMRect(
          0,
          index * 20 + (index >= 5 ? addedHeight : 0) - (body?.scrollTop ?? 0),
          100,
          16,
        );
      };
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        function (this: Element) {
          return rectOf(this);
        },
      );
      vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
        function (this: HTMLElement) {
          return [rectOf(this)] as unknown as DOMRectList;
        },
      );
      let position: ScriptPaneReadingPosition | null = {
        kind: "word",
        index: 5,
        offset: 0,
        fallbackTop: 100,
      };
      const binding: ScriptPaneReadingPositionBinding = {
        getPosition: () => position,
        capture: (next) => {
          position = next;
        },
        restore: true,
      };
      const onSelect = vi.fn();
      const onSelectionEnd = vi.fn();
      const onUserScroll = vi.fn();
      function Host({
        handles = true,
        shown = true,
      }: {
        handles?: boolean;
        shown?: boolean;
      }) {
        const [selection, setSelection] = useState<
          ScriptPaneProps["selection"]
        >({ kind: "words", anchor: 8, head: 14 });
        return (
          <ScriptPane
            turns={SCRIPT_TURNS}
            readingPosition={binding}
            following={false}
            handles={handles}
            status={shown ? { kind: "ready" } : { kind: "loading" }}
            selection={selection}
            onSelect={(next) => {
              onSelect(next);
              setSelection(next);
            }}
            onSelectionEnd={onSelectionEnd}
            onUserScroll={onUserScroll}
          />
        );
      }
      const view = render(<Host />);
      const body =
        view.container.querySelector<HTMLElement>(".sys-script-body");
      if (!body) throw new Error("Expected script body");
      let top = body.scrollTop;
      Object.defineProperty(body, "scrollTop", {
        configurable: true,
        get: () => top,
        set: (next: number) => {
          top = Math.max(
            0,
            Math.min(next, body.scrollHeight - body.clientHeight),
          );
        },
      });
      const grip = () => {
        const result = body.querySelector<HTMLElement>(`[data-edge="${edge}"]`);
        if (!result) throw new Error("Expected visible grip");
        return result;
      };
      const pointer = {
        pointerId: 7,
        pointerType: "touch",
        isPrimary: true,
        clientX: 50,
      };
      const grab = () => {
        const handle = grip();
        const capture = vi.fn();
        handle.setPointerCapture = capture;
        const rect = handle.getBoundingClientRect();
        fireEvent.pointerDown(handle, {
          ...pointer,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        });
        expect(capture).toHaveBeenCalledExactlyOnceWith(7);
        return handle;
      };
      const restore = () => {
        act(() => {
          fonts.dispatchEvent(new Event("loadingdone"));
          for (const observer of FakeResizeObserver.all) observer.fire(body);
          vi.advanceTimersByTime(16);
        });
      };
      const handle = grab();
      fireEvent.pointerMove(handle, { ...pointer, clientY: 108 });
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(
        edge === "start"
          ? { kind: "words", anchor: 10, head: 14 }
          : { kind: "words", anchor: 8, head: 10 },
      );
      addedHeight = 40;
      restore();
      expect.soft(body.scrollTop).toBe(100);
      fireEvent.pointerMove(handle, { ...pointer, clientY: 128 });
      expect
        .soft(onSelect)
        .toHaveBeenLastCalledWith(
          edge === "start"
            ? { kind: "words", anchor: 9, head: 14 }
            : { kind: "words", anchor: 8, head: 9 },
        );
      expect(onSelect).toHaveBeenCalledTimes(2);
      fireEvent.pointerUp(handle, { ...pointer, clientY: 128 });
      expect(onSelectionEnd).not.toHaveBeenCalled();
      expect(onUserScroll).not.toHaveBeenCalled();
      addedHeight = 60;
      restore();
      expect.soft(body.scrollTop).toBe(120);

      for (const exit of [
        "cancel",
        "lost",
        "escape",
        "removed",
        "hidden",
      ] as const) {
        addedHeight = 0;
        body.scrollTop = 100;
        fireEvent.wheel(body);
        fireEvent.scroll(body);
        const held = grab();
        addedHeight = 40;
        restore();
        expect.soft(body.scrollTop).toBe(100);
        if (exit === "cancel") fireEvent.pointerCancel(held, pointer);
        else if (exit === "lost") fireEvent.lostPointerCapture(held, pointer);
        else if (exit === "escape") fireEvent.keyDown(held, { key: "Escape" });
        else if (exit === "removed") {
          view.rerender(<Host handles={false} />);
          expect(body.querySelector(".sys-handle")).toBeNull();
          view.rerender(<Host />);
        } else {
          view.rerender(<Host shown={false} />);
          expect(view.container.querySelector(".sys-script-body")).toBeNull();
          view.rerender(<Host />);
          break;
        }
        addedHeight = 60;
        restore();
        expect.soft(body.scrollTop).toBe(120);
      }
      const restored =
        view.container.querySelector<HTMLElement>(".sys-script-body");
      if (!restored) throw new Error("Expected restored script body");
      expect.soft(restored.scrollTop).toBe(100);
      addedHeight = 60;
      act(() => {
        fonts.dispatchEvent(new Event("loadingdone"));
      });
      expect.soft(restored.scrollTop).toBe(120);
      const lastGrip = restored.querySelector<HTMLElement>(
        `[data-edge="${edge}"]`,
      );
      if (!lastGrip) throw new Error("Expected grip before retirement");
      fireEvent.pointerDown(lastGrip, { ...pointer, clientY: 100 });
      view.unmount();
      const remounted = render(<Host />);
      expect(
        remounted.container.querySelector<HTMLElement>(".sys-script-body")
          ?.scrollTop,
      ).toBe(120);
    },
  );

  it("yields restoration during a held selection before any edge scrolling", () => {
    const geometry = scriptGeometry();
    stubResizeObserver();
    const fonts = new EventTarget();
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fonts,
    });
    let position: ScriptPaneReadingPosition | null = {
      kind: "word",
      index: 5,
      offset: 0,
      fallbackTop: 100,
    };
    const binding: ScriptPaneReadingPositionBinding = {
      getPosition: () => position,
      capture: (next) => {
        position = next;
      },
      restore: true,
    };
    const onSelect = vi.fn();
    const onUserScroll = vi.fn();
    const { container } = render(
      <ScriptPane
        turns={SCRIPT_TURNS}
        readingPosition={binding}
        following={false}
        onSelect={onSelect}
        onUserScroll={onUserScroll}
      />,
    );
    const body = container.querySelector<HTMLElement>(".sys-script-body");
    const word = body?.querySelector<HTMLElement>('[data-stop="5"]');
    if (!body || !word) throw new Error("Expected selection words");
    document.elementFromPoint = (_x, y) =>
      body.querySelector(
        `[data-stop="${Math.floor((y + body.scrollTop) / 24)}"]`,
      );
    geometry.setLineHeight(24);
    fireEvent.pointerDown(word, {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: 10,
      clientY: 25,
    });
    fireEvent.pointerMove(body, {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: 10,
      clientY: 100,
    });
    expect(body).toHaveAttribute("data-selecting");
    expect(document.elementFromPoint(10, 100)?.textContent).toBe("talking");
    act(() => {
      fonts.dispatchEvent(new Event("loadingdone"));
      for (const observer of FakeResizeObserver.all) observer.fire(body);
    });
    expect(body.scrollTop).toBe(100);
    expect(position).toMatchObject({
      kind: "word",
      index: 4,
      fallbackTop: 100,
    });
    fireEvent.pointerUp(body, {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: 10,
      clientY: 100,
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({
      kind: "words",
      anchor: 5,
      head: 8,
    });
    expect(onUserScroll).not.toHaveBeenCalled();
  });

  it.each(["superseded", "imperative", "retired", "blurred"])(
    "guards queued native focus capture when %s before the microtask",
    async (transition) => {
      scriptGeometry();
      const ref = createRef<ScriptPaneHandle>();
      let position: ScriptPaneReadingPosition | null = {
        kind: "scroll",
        top: 100,
      };
      const capture = vi.fn((next: ScriptPaneReadingPosition) => {
        position = next;
      });
      const binding: ScriptPaneReadingPositionBinding = {
        getPosition: () => position,
        capture,
        restore: true,
      };
      const view = render(
        <StrictMode>
          <ScriptPane
            ref={ref}
            turns={SCRIPT_TURNS}
            readingPosition={binding}
          />
        </StrictMode>,
      );
      const body =
        view.container.querySelector<HTMLElement>(".sys-script-body");
      const first = body?.querySelector<HTMLElement>('[data-stop="5"]');
      const second = body?.querySelector<HTMLElement>('[data-stop="8"]');
      if (!body || !first || !second) throw new Error("Expected focus words");
      await act(async () => {
        first.focus();
        if (transition === "superseded") second.focus();
        else if (transition === "imperative")
          expect(ref.current?.focusWord(8)).toBe(true);
        else if (transition === "retired") view.unmount();
        else first.blur();
        await Promise.resolve();
      });
      if (transition === "superseded") {
        expect(document.activeElement).toBe(second);
        expect(capture).toHaveBeenCalledExactlyOnceWith({
          kind: "word",
          intent: "focus",
          index: 8,
          offset: 60,
          fallbackTop: 100,
          turns: SCRIPT_TURNS,
        });
      } else {
        expect(capture).not.toHaveBeenCalled();
        expect(position).toEqual({ kind: "scroll", top: 100 });
        if (transition === "imperative")
          expect(document.activeElement).toBe(second);
      }
    },
  );

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
