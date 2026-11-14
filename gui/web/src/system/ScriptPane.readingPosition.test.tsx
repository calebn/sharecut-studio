import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, StrictMode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuestScript } from "../stages/guest/GuestScript";
import { useGuestReading } from "../stages/guest/useGuestReading";
import { expectNoA11yViolations } from "../test/a11y";
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
  const fixtureStyle = document.head.appendChild(
    document.createElement("style"),
  );
  fixtureStyle.dataset.readingPositionFixture = "true";
  fixtureStyle.textContent = ".sys-script-word { outline-style: none; }";
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
  const fixtureStyle = document.head.appendChild(
    document.createElement("style"),
  );
  fixtureStyle.dataset.readingPositionFixture = "true";
  fixtureStyle.textContent = `
    .sys-script-body, .rv-main { overflow-x: auto; overflow-y: auto; }
    .sys-script-word { outline-style: solid; outline-width: 2px; outline-offset: 2px; }
  `;
  let paneHeight = 400;
  let outerHeight = 600;
  let bodyPresent = true;
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
    setOuterHeight: (height: number) => {
      outerHeight = height;
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
    document.head
      .querySelectorAll('style[data-reading-position-fixture="true"]')
      .forEach((style) => style.remove());
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
    fireEvent.wheel(body, { deltaY: 600 });
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
    fireEvent.wheel(body, { deltaY: 590 });
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
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    stubResizeObserver();
    const onUserScroll = vi.fn();
    const { body, captured } = setup(
      { kind: "scroll", top: 400 },
      false,
      onUserScroll,
    );
    expect(body.scrollTop).toBe(400);
    fireEvent.wheel(body, { deltaY: 100 });
    body.scrollTop = 500;
    fireEvent.scroll(body);
    expect(captured()).toMatchObject({ kind: "word", fallbackTop: 500 });
    fireEvent.wheel(body, { deltaY: -100 });
    body.scrollTop = 400;
    fireEvent.scroll(body);
    expect(captured()).toMatchObject({ kind: "word", fallbackTop: 400 });
    expect(onUserScroll).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(600);
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
    fireEvent.wheel(body, { deltaY: 590 });
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
      fireEvent.wheel(body, { deltaY: 590 });
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

  it("keeps a wheel scroll delivered after a stationary contact ends", () => {
    scriptGeometry();
    stubResizeObserver();
    const onUserScroll = vi.fn();
    const { body, captured } = setup(null, false, onUserScroll);
    body.scrollTop = 590;
    fireEvent.wheel(body, { deltaY: 20 });
    fireEvent.scroll(body);
    fireEvent.touchStart(body, {
      touches: [{ identifier: 1, target: body, clientY: 160 }],
    });
    fireEvent.wheel(body, { deltaY: 80 });
    body.scrollTop = 670;
    fireEvent.touchEnd(body, {
      touches: [],
      changedTouches: [{ identifier: 1, target: body, clientY: 160 }],
    });
    fireEvent.scroll(body);
    for (const observer of FakeResizeObserver.all) observer.fire(body);

    expect(body.scrollTop).toBe(670);
    expect(captured()).toMatchObject({
      kind: "word",
      index: 33,
      fallbackTop: 670,
    });
    expect(onUserScroll).toHaveBeenCalledTimes(2);
  });

  it("keeps a bottom reading anchor when font reflow only shrinks the scroll range", () => {
    const geometry = scriptGeometry();
    let extent = 1200;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      () => extent,
    );
    const fonts = new EventTarget();
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fonts,
    });
    const onUserScroll = vi.fn();
    const { body, captured } = setup(null, false, onUserScroll);
    body.scrollTop = 1000;
    fireEvent.wheel(body, { deltaY: 20 });
    fireEvent.scroll(body);
    expect(captured()).toMatchObject({
      kind: "word",
      index: 50,
      fallbackTop: 1000,
    });

    geometry.setLineHeight(16);
    extent = 960;
    body.scrollTop = extent - body.clientHeight;
    fireEvent.wheel(body, { deltaY: 20 });
    fireEvent.scroll(body);
    geometry.setLineHeight(20);
    extent = 1200;
    act(() => {
      fonts.dispatchEvent(new Event("loadingdone"));
    });

    expect(body.scrollTop).toBe(1000);
    expect(captured()).toMatchObject({
      kind: "word",
      index: 50,
      fallbackTop: 1000,
    });
    expect(onUserScroll).toHaveBeenCalledOnce();
  });

  it.each(["zoom", "prevented"] as const)(
    "does not turn a %s wheel into reading movement during font reflow",
    (input) => {
      const geometry = scriptGeometry();
      const fonts = new EventTarget();
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: fonts,
      });
      const onUserScroll = vi.fn();
      const { body, captured } = setup(null, false, onUserScroll);
      body.scrollTop = 590;
      fireEvent.wheel(body, { deltaY: 20 });
      fireEvent.scroll(body);
      if (input === "zoom") {
        fireEvent.wheel(body, { deltaY: 80, ctrlKey: true });
      } else {
        const wheel = new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: 80,
        });
        wheel.preventDefault();
        fireEvent(body, wheel);
      }
      geometry.setLineHeight(24);
      body.scrollTop = 670;
      act(() => {
        fonts.dispatchEvent(new Event("loadingdone"));
      });

      expect(body.scrollTop).toBe(706);
      expect(captured()).toMatchObject({
        kind: "word",
        index: 29,
        fallbackTop: 590,
      });
      expect(onUserScroll).toHaveBeenCalledOnce();
    },
  );

  it.each(["geometry-first", "scroll-first"] as const)(
    "does not treat selection-grip touch movement as reading input with %s delivery",
    (order) => {
      const geometry = scriptGeometry();
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
      const onUserScroll = vi.fn();
      const { body, binding, captured, rerender } = setup(
        null,
        false,
        onUserScroll,
      );
      rerender(
        <ScriptPane
          turns={SCRIPT_TURNS}
          readingPosition={binding}
          onUserScroll={onUserScroll}
          following={false}
          handles
          selection={{ kind: "words", anchor: 30, head: 31 }}
          onSelect={vi.fn()}
        />,
      );
      body.scrollTop = 590;
      fireEvent.wheel(body, { deltaY: 20 });
      fireEvent.scroll(body);
      const grip = body.querySelector<HTMLElement>('[data-edge="end"]');
      if (!grip) throw new Error("Expected selection grip");
      grip.setPointerCapture = vi.fn();
      const pointer = {
        pointerId: 7,
        pointerType: "touch",
        isPrimary: true,
        clientX: 50,
      };
      fireEvent.pointerDown(grip, { ...pointer, clientY: 160 });
      fireEvent.touchStart(grip, {
        touches: [{ identifier: 1, target: grip, clientY: 160 }],
      });
      fireEvent.pointerMove(grip, { ...pointer, clientY: 80 });
      fireEvent.touchMove(grip, {
        touches: [{ identifier: 1, target: grip, clientY: 80 }],
      });
      fireEvent.pointerUp(grip, { ...pointer, clientY: 80 });
      fireEvent.touchEnd(grip, {
        touches: [],
        changedTouches: [{ identifier: 1, target: grip, clientY: 80 }],
      });
      geometry.setLineHeight(24);
      body.scrollTop = 670;
      if (order === "scroll-first") fireEvent.scroll(body);
      act(() => {
        fonts.dispatchEvent(new Event("loadingdone"));
      });

      expect(body.scrollTop).toBe(706);
      expect(captured()).toMatchObject({
        kind: "word",
        index: 29,
        fallbackTop: 590,
      });
      expect(onUserScroll).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["following", null, false],
    ["paused", { kind: "scroll", top: 0 }, true],
  ] as const)(
    "retains a native-style post-applied wheel before its queued scroll while %s",
    (_mode, position, restore) => {
      scriptGeometry();
      const onUserScroll = vi.fn();
      const { body, binding, captured, rerender, container } = setup(
        position,
        false,
        onUserScroll,
        restore,
      );
      body.scrollTop = 170;
      fireEvent.wheel(body, { deltaY: 170 });
      expect.soft(captured()).toMatchObject({
        kind: "word",
        index: 8,
        offset: -10,
        fallbackTop: 170,
      });
      expect.soft(onUserScroll).toHaveBeenCalledOnce();
      rerender(
        <ScriptPane
          turns={SCRIPT_TURNS}
          readingPosition={binding}
          status={{ kind: "loading" }}
        />,
      );
      expect(container.querySelector(".sys-script-body")).toBeNull();
      rerender(
        <ScriptPane
          turns={SCRIPT_TURNS}
          readingPosition={{ ...binding, restore: true }}
          onUserScroll={onUserScroll}
        />,
      );
      expect(
        container.querySelector<HTMLElement>(".sys-script-body")?.scrollTop,
      ).toBe(170);
      expect(onUserScroll).toHaveBeenCalledOnce();
    },
  );

  it("does not give a zero-delta wheel ownership of a font-reflow scroll", () => {
    const geometry = scriptGeometry();
    const fonts = new EventTarget();
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fonts,
    });
    const onUserScroll = vi.fn();
    const { body, captured } = setup(
      { kind: "word", index: 29, offset: -10, fallbackTop: 590 },
      false,
      onUserScroll,
    );
    fireEvent.scroll(body);
    geometry.setLineHeight(24);
    body.scrollTop = 650;
    fireEvent.wheel(body, { deltaY: 0 });
    fireEvent.scroll(body);
    act(() => {
      fonts.dispatchEvent(new Event("loadingdone"));
    });

    expect(body.scrollTop).toBe(706);
    expect(captured()).toMatchObject({
      kind: "word",
      index: 29,
      fallbackTop: 590,
    });
    expect(onUserScroll).not.toHaveBeenCalled();
  });

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
      fireEvent.wheel(body, { deltaY: 590 });
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

  it.each([
    ["key", "observer-first"],
    ["key", "scroll-first"],
    ["scrollbar", "observer-first"],
    ["scrollbar", "scroll-first"],
  ] as const)(
    "keeps %s reading movement through a %s geometry collision",
    (input, order) => {
      const geometry = scriptGeometry();
      stubResizeObserver();
      const onUserScroll = vi.fn();
      const { body, captured } = setup(null, false, onUserScroll);
      body.scrollTop = 590;
      fireEvent.wheel(body, { deltaY: 590 });
      fireEvent.scroll(body);
      if (input === "key") fireEvent.keyDown(body, { key: "PageDown" });
      else
        fireEvent.pointerDown(body, {
          pointerId: 3,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
        });
      geometry.resize(201, 408);
      body.scrollTop = 670;
      if (order === "observer-first")
        for (const observer of FakeResizeObserver.all) observer.fire(body);
      else fireEvent.scroll(body);

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

  it("keeps unobserved input through an unchanged geometry callback", () => {
    const geometry = scriptGeometry();
    stubResizeObserver();
    const onUserScroll = vi.fn();
    const { body, captured } = setup(null, false, onUserScroll);
    body.scrollTop = 590;
    fireEvent.wheel(body, { deltaY: 590 });
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
      fireEvent.wheel(body, { deltaY: 590 });
      fireEvent.scroll(body);
      expect(captured()).toMatchObject({ fallbackTop: 590 });
      expect(onUserScroll).toHaveBeenCalledOnce();
      fireEvent.wheel(body, { deltaY: 80 });
      body.scrollTop = 650;
      fireEvent.wheel(body, { deltaY: 40 });
      expect(captured()).toMatchObject({ fallbackTop: 650 });
      expect(onUserScroll).toHaveBeenCalledTimes(2);
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
      expect(onUserScroll).toHaveBeenCalledTimes(3);
      const saved = captured();
      fireEvent.scroll(body);
      expect(captured()).toBe(saved);
      expect(onUserScroll).toHaveBeenCalledTimes(3);
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
      fireEvent.wheel(body, { deltaY: 590 });
      fireEvent.scroll(body);
      expect(captured()).toMatchObject({ fallbackTop: 590 });
      expect(onUserScroll).toHaveBeenCalledOnce();
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
      expect(captured()).toMatchObject({ fallbackTop: 650 });
      expect(onUserScroll).toHaveBeenCalledTimes(2);
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
      expect(onUserScroll).toHaveBeenCalledTimes(3);
      const saved = captured();
      fireEvent.scroll(body);
      expect(captured()).toBe(saved);
      expect(onUserScroll).toHaveBeenCalledTimes(3);
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
    "accepts post-applied wheel movement followed by fresh %s movement",
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
      expect(captured()).toMatchObject({ fallbackTop: 650 });
      expect(onUserScroll).toHaveBeenCalledOnce();
      fireEvent.scroll(body);
      expect(onUserScroll).toHaveBeenCalledOnce();
      clock.mockReturnValue(650);
      if (renewal === "key") fireEvent.keyDown(body, { key: "PageDown" });
      else
        fireEvent.pointerDown(body, {
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
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
      expect(onUserScroll).toHaveBeenCalledTimes(2);
      const saved = captured();
      fireEvent.scroll(body);
      expect(captured()).toBe(saved);
      expect(onUserScroll).toHaveBeenCalledTimes(2);
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
    fireEvent.wheel(body, { deltaY: 20 });
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
    fireEvent.wheel(body, { deltaY: 72 });
    body.scrollTop = 500;
    fireEvent.scroll(body);
    expect(onUserScroll).toHaveBeenCalledOnce();
  });

  it.each([
    ["wheel", "resize"],
    ["wheel", "font"],
    ["touch", "resize"],
    ["touch", "font"],
  ] as const)(
    "retains newer %s movement after acknowledging a restore before %s",
    (input, observation) => {
      const geometry = scriptGeometry();
      vi.spyOn(performance, "now").mockReturnValue(0);
      stubResizeObserver();
      const fonts = new EventTarget();
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: fonts,
      });
      const onUserScroll = vi.fn();
      const { body, captured } = setup(
        { kind: "scroll", top: 590 },
        false,
        onUserScroll,
      );
      expect(body.scrollTop).toBe(590);
      if (input === "wheel") fireEvent.wheel(body, { deltaY: 80 });
      else {
        fireEvent.touchStart(body, {
          touches: [{ identifier: 1, target: body, clientY: 160 }],
        });
        fireEvent.touchMove(body, {
          touches: [{ identifier: 1, target: body, clientY: 80 }],
        });
      }
      fireEvent.scroll(body);
      expect(captured()).toEqual({ kind: "scroll", top: 590 });
      expect(onUserScroll).not.toHaveBeenCalled();
      body.scrollTop = 670;
      geometry.resize(201, 408);
      act(() => {
        if (observation === "font")
          fonts.dispatchEvent(new Event("loadingdone"));
        else for (const observer of FakeResizeObserver.all) observer.fire(body);
      });
      expect.soft(body.scrollTop).toBe(670);
      expect.soft(captured()).toMatchObject({
        kind: "word",
        index: 33,
        fallbackTop: 670,
      });
      fireEvent.scroll(body);
      expect(onUserScroll).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["cancelled", "prevented"] as const)(
    "rejects same-box reflow scroll before font delivery after a %s touch",
    (input) => {
      const geometry = scriptGeometry();
      const fonts = new EventTarget();
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: fonts,
      });
      const onUserScroll = vi.fn();
      const { body, captured } = setup(
        { kind: "word", index: 29, offset: -10, fallbackTop: 590 },
        false,
        onUserScroll,
      );
      fireEvent.scroll(body);
      const saved = captured();
      fireEvent.touchStart(body, {
        touches: [{ identifier: 1, target: body, clientY: 160 }],
      });
      const move = createEvent.touchMove(body, {
        cancelable: true,
        touches: [{ identifier: 1, target: body, clientY: 80 }],
        changedTouches: [{ identifier: 1, target: body, clientY: 80 }],
      });
      if (input === "prevented") {
        move.preventDefault();
        expect(move.defaultPrevented).toBe(true);
      }
      fireEvent(body, move);
      const end = {
        touches: [],
        changedTouches: [{ identifier: 1, target: body, clientY: 80 }],
      };
      if (input === "cancelled") fireEvent.touchCancel(body, end);
      else fireEvent.touchEnd(body, end);
      geometry.setLineHeight(24);
      body.scrollTop = 670;
      fireEvent.scroll(body);
      expect.soft(captured()).toBe(saved);
      expect.soft(onUserScroll).not.toHaveBeenCalled();
      act(() => {
        fonts.dispatchEvent(new Event("loadingdone"));
      });
      expect(body.scrollTop).toBe(706);
      expect(captured()).toMatchObject({
        kind: "word",
        index: 29,
        offset: -10,
        fallbackTop: 590,
      });
    },
  );

  it.each([
    ["bound", "ctrl"],
    ["bound", "prevented"],
    ["unbound", "ctrl"],
    ["unbound", "prevented"],
  ] as const)(
    "keeps the %s Follow contract for a %s wheel",
    (bindingMode, input) => {
      scriptGeometry();
      let position: ScriptPaneReadingPosition | null = null;
      const onUserScroll = vi.fn();
      function Host() {
        const [following, setFollowing] = useState(true);
        return (
          <ScriptPane
            turns={SCRIPT_TURNS}
            following={following}
            onFollowChange={setFollowing}
            onUserScroll={() => {
              onUserScroll();
              setFollowing(false);
            }}
            readingPosition={
              bindingMode === "bound"
                ? {
                    getPosition: () => position,
                    capture: (next) => {
                      position = next;
                    },
                    restore: !following,
                  }
                : undefined
            }
          />
        );
      }
      const { container } = render(<Host />);
      const body = container.querySelector<HTMLElement>(".sys-script-body");
      if (!body) throw new Error("Expected script body");
      const follow = screen.getByRole("button", {
        name: "Follow the playhead",
      });
      expect(follow).toHaveAttribute("aria-pressed", "true");
      const wheel = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 80,
        ctrlKey: input === "ctrl",
      });
      if (input === "prevented") wheel.preventDefault();
      fireEvent(body, wheel);
      body.scrollTop = 80;
      fireEvent.scroll(body);
      expect
        .soft(follow)
        .toHaveAttribute(
          "aria-pressed",
          bindingMode === "bound" ? "true" : "false",
        );
      expect
        .soft(onUserScroll)
        .toHaveBeenCalledTimes(bindingMode === "bound" ? 0 : 1);
      fireEvent.wheel(body, { deltaY: 80 });
      body.scrollTop = 160;
      fireEvent.scroll(body);
      expect(follow).toHaveAttribute("aria-pressed", "false");
      expect(onUserScroll).toHaveBeenCalledTimes(
        bindingMode === "bound" ? 1 : 2,
      );
      if (bindingMode === "bound")
        expect(position).toMatchObject({
          kind: "word",
          index: 8,
          fallbackTop: 160,
        });
    },
  );

  it.each(["window", "observer"] as const)(
    "fits the focused word ring after an ancestor-only %s resize",
    async (delivery) => {
      const geometry = nestedScrollGeometry(300);
      stubResizeObserver();
      vi.stubGlobal("innerHeight", 1000);
      let position: ScriptPaneReadingPosition | null = null;
      const binding: ScriptPaneReadingPositionBinding = {
        getPosition: () => position,
        capture: (next) => {
          position = next;
        },
        restore: true,
      };
      const { container } = render(
        <div className="rv-main">
          <ScriptPane
            turns={SCRIPT_TURNS}
            following={false}
            readingPosition={binding}
          />
        </div>,
      );
      const body = container.querySelector<HTMLElement>(".sys-script-body");
      const outer = container.querySelector<HTMLElement>(".rv-main");
      const word = body?.querySelector<HTMLElement>('[data-stop="15"]');
      if (!body || !outer || !word)
        throw new Error("Expected nested reading pane");
      await act(async () => word.focus());
      expect(document.activeElement).toBe(word);
      expect(word.textContent).toBe("sound");
      expect(position).toMatchObject({
        kind: "word",
        index: 15,
        intent: "focus",
      });
      expect(word.getBoundingClientRect().bottom + 4).toBe(620);
      geometry.setOuterHeight(450);
      vi.stubGlobal("innerHeight", 850);
      if (delivery === "window") fireEvent(window, new Event("resize"));
      else FakeResizeObserver.of(outer).fire(outer);
      expect(body.clientHeight).toBe(400);
      expect(document.activeElement).toBe(word);
      expect(word.getBoundingClientRect().top - 4).toBeGreaterThanOrEqual(
        Math.max(
          0,
          body.getBoundingClientRect().top,
          outer.getBoundingClientRect().top,
        ),
      );
      expect(word.getBoundingClientRect().bottom + 4).toBeLessThanOrEqual(
        Math.min(
          innerHeight,
          body.getBoundingClientRect().bottom,
          outer.getBoundingClientRect().bottom,
        ),
      );
    },
  );

  it.each(["word drag", "grip hold"] as const)(
    "preserves explicit follow navigation during a %s hold",
    (owner) => {
      vi.useFakeTimers({
        toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
      });
      scriptGeometry();
      vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
        function (this: HTMLElement) {
          return [this.getBoundingClientRect()] as unknown as DOMRectList;
        },
      );
      const ref = createRef<ScriptPaneHandle>();
      let position: ScriptPaneReadingPosition | null = {
        kind: "scroll",
        top: 100,
      };
      const binding: ScriptPaneReadingPositionBinding = {
        getPosition: () => position,
        capture: (next) => {
          position = next;
        },
        restore: false,
      };
      function Host() {
        const [selection, setSelection] = useState<
          ScriptPaneProps["selection"]
        >({ kind: "words", anchor: 8, head: 9 });
        return (
          <ScriptPane
            ref={ref}
            turns={SCRIPT_TURNS}
            readingPosition={binding}
            following
            handles
            selection={selection}
            onSelect={setSelection}
          />
        );
      }
      const { container } = render(<Host />);
      const body = container.querySelector<HTMLElement>(".sys-script-body");
      const word = body?.querySelector<HTMLElement>('[data-stop="8"]');
      const grip = body?.querySelector<HTMLElement>('[data-edge="end"]');
      if (!body || !word || !grip)
        throw new Error("Expected selectable words and grip");
      act(() => {
        expect(ref.current?.scrollToWord(5, "start")).toBe(true);
      });
      document.elementFromPoint = (_x, y) =>
        body.querySelector(
          `[data-stop="${Math.floor((y + body.scrollTop) / 20)}"]`,
        );
      const target = owner === "word drag" ? word : grip;
      const capturePointer = vi.fn();
      target.setPointerCapture = capturePointer;
      const pointer = {
        pointerId: 7,
        pointerType: owner === "word drag" ? "mouse" : "touch",
        isPrimary: true,
        clientX: 50,
        clientY: 88,
      };
      fireEvent.pointerDown(target, {
        ...pointer,
        clientY: owner === "word drag" ? 68 : 88,
      });
      if (owner === "word drag") {
        fireEvent.pointerMove(body, pointer);
        expect(body).toHaveAttribute("data-selecting");
      } else expect(capturePointer).toHaveBeenCalledExactlyOnceWith(7);
      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(body.scrollTop).toBe(100);
      expect(document.elementFromPoint(50, 88)?.textContent).toBe("about");
      act(() => {
        expect(ref.current?.scrollToWord(40, "center")).toBe(true);
      });
      expect.soft(body.scrollTop).toBe(708);
      expect
        .soft(document.elementFromPoint(50, 88)?.textContent)
        .toBe("microphones.");
      fireEvent.pointerUp(owner === "word drag" ? body : target, pointer);
      act(() => {
        expect(ref.current?.scrollToWord(5, "center")).toBe(true);
      });
      expect(body.scrollTop).toBe(8);
      act(() => {
        expect(ref.current?.scrollToWord(40, "center")).toBe(true);
      });
      expect(body.scrollTop).toBe(708);
    },
  );

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
      fireEvent.wheel(body, { deltaY: 20 });
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
      fireEvent.wheel(body, { deltaY: 600 });
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
      fireEvent.wheel(body, { deltaY: 444 });
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
      fireEvent.wheel(body, { deltaY: 382 });
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
        fireEvent.wheel(body, { deltaY: -20 });
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

  it("accepts every native-style PageDown animation point from one keydown", () => {
    scriptGeometry();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const onUserScroll = vi.fn();
    const { body, captured } = setup(
      { kind: "scroll", top: 0 },
      false,
      onUserScroll,
    );
    fireEvent.keyDown(body, { key: "PageDown" });
    for (const [time, top, index, count] of [
      [36, 30, 1, 1],
      [199, 74, 3, 2],
      [202, 368, 18, 3],
    ]) {
      clock.mockReturnValue(time);
      body.scrollTop = top;
      fireEvent.scroll(body);
      expect(captured()).toMatchObject({
        kind: "word",
        index,
        fallbackTop: top,
      });
      expect(onUserScroll).toHaveBeenCalledTimes(count);
      const saved = captured();
      fireEvent.scroll(body);
      expect(captured()).toBe(saved);
      expect(onUserScroll).toHaveBeenCalledTimes(count);
    }
  });

  it("keeps delayed touch movement and distinct momentum points after touchend", () => {
    scriptGeometry();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const onUserScroll = vi.fn();
    const { body, captured } = setup(
      { kind: "scroll", top: 12 },
      false,
      onUserScroll,
    );
    fireEvent.scroll(body);
    fireEvent.touchStart(body, { touches: [{ identifier: 1, clientY: 172 }] });
    clock.mockReturnValue(70);
    fireEvent.touchMove(body, { touches: [{ identifier: 1, clientY: 152 }] });
    clock.mockReturnValue(252);
    body.scrollTop = 17;
    fireEvent.scroll(body);
    expect(captured()).toMatchObject({ fallbackTop: 17 });
    clock.mockReturnValue(255);
    body.scrollTop = 27;
    const delayed = createEvent.touchMove(body, {
      touches: [{ identifier: 1, clientY: 142 }],
    });
    Object.defineProperty(delayed, "timeStamp", { value: 239 });
    fireEvent(body, delayed);
    expect(captured()).toMatchObject({ fallbackTop: 27 });
    expect(onUserScroll).toHaveBeenCalledTimes(2);
    fireEvent.scroll(body);
    expect(onUserScroll).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(318);
    body.scrollTop = 47;
    fireEvent.touchEnd(body, {
      touches: [],
      changedTouches: [{ identifier: 1, clientY: 122 }],
    });
    expect(captured()).toMatchObject({ fallbackTop: 47 });
    expect(onUserScroll).toHaveBeenCalledTimes(3);
    for (const [time, top, count] of [
      [352, 56, 4],
      [702, 130, 5],
    ]) {
      clock.mockReturnValue(time);
      body.scrollTop = top;
      fireEvent.scroll(body);
      expect(captured()).toMatchObject({ fallbackTop: top });
      expect(onUserScroll).toHaveBeenCalledTimes(count);
    }
  });

  it.each(["key", "pointer"] as const)(
    "does not revive expired 590 evidence with fresh %s input at unchanged 650",
    (input) => {
      scriptGeometry();
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
      clock.mockReturnValue(601);
      body.scrollTop = 650;
      fireEvent.scroll(body);
      expect(captured()).toEqual({ kind: "scroll", top: 590 });
      if (input === "key") fireEvent.keyDown(body, { key: "PageDown" });
      else
        fireEvent.pointerDown(body, {
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
        });
      for (const observer of FakeResizeObserver.all) observer.fire(body);
      expect(body.scrollTop).toBe(590);
      expect(captured()).toEqual({ kind: "scroll", top: 590 });
      expect(onUserScroll).not.toHaveBeenCalled();
    },
  );

  it.each(["key", "pointer"] as const)(
    "keeps accepted 650 without another notification for stationary %s input",
    (input) => {
      scriptGeometry();
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
      expect(captured()).toMatchObject({ fallbackTop: 650 });
      const saved = captured();
      clock.mockReturnValue(650);
      if (input === "key") fireEvent.keyDown(body, { key: "PageDown" });
      else
        fireEvent.pointerDown(body, {
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
        });
      for (const observer of FakeResizeObserver.all) observer.fire(body);
      fireEvent.scroll(body);
      expect(body.scrollTop).toBe(650);
      expect(captured()).toBe(saved);
      expect(onUserScroll).toHaveBeenCalledOnce();
    },
  );

  it.each([599, 600])(
    "expires pending input at 600 ms, observed at %i",
    (elapsed) => {
      scriptGeometry();
      stubResizeObserver();
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      const onUserScroll = vi.fn();
      const { body, captured } = setup(
        { kind: "scroll", top: 590 },
        false,
        onUserScroll,
      );
      fireEvent.scroll(body);
      fireEvent.keyDown(body, { key: "PageDown" });
      clock.mockReturnValue(500);
      fireEvent.wheel(body, { deltaY: 0 });
      fireEvent.scroll(body);
      for (const observer of FakeResizeObserver.all) observer.fire(body);
      clock.mockReturnValue(elapsed);
      body.scrollTop = 670;
      fireEvent.scroll(body);
      for (const observer of FakeResizeObserver.all) observer.fire(body);
      expect(body.scrollTop).toBe(elapsed === 599 ? 670 : 590);
      expect(captured()).toMatchObject(
        elapsed === 599
          ? { kind: "word", fallbackTop: 670 }
          : { kind: "scroll", top: 590 },
      );
      expect(onUserScroll).toHaveBeenCalledTimes(elapsed === 599 ? 1 : 0);
    },
  );

  it.each([599, 600])(
    "expires moving evidence by its last distinct point with a gap of %i",
    (gap) => {
      scriptGeometry();
      stubResizeObserver();
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      const onUserScroll = vi.fn();
      const { body, captured } = setup(
        { kind: "scroll", top: 590 },
        false,
        onUserScroll,
      );
      fireEvent.scroll(body);
      fireEvent.keyDown(body, { key: "PageDown" });
      clock.mockReturnValue(500);
      body.scrollTop = 650;
      fireEvent.scroll(body);
      clock.mockReturnValue(1000);
      fireEvent.scroll(body);
      fireEvent.wheel(body, { deltaY: 0 });
      for (const observer of FakeResizeObserver.all) observer.fire(body);
      clock.mockReturnValue(500 + gap);
      body.scrollTop = 670;
      fireEvent.scroll(body);
      for (const observer of FakeResizeObserver.all) observer.fire(body);
      expect(body.scrollTop).toBe(gap === 599 ? 670 : 650);
      expect(captured()).toMatchObject({
        fallbackTop: gap === 599 ? 670 : 650,
      });
      expect(onUserScroll).toHaveBeenCalledTimes(gap === 599 ? 2 : 1);
    },
  );

  it("keeps the original pending touch age across release", () => {
    scriptGeometry();
    stubResizeObserver();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const onUserScroll = vi.fn();
    const { body, captured } = setup(
      { kind: "scroll", top: 590 },
      false,
      onUserScroll,
    );
    fireEvent.scroll(body);
    fireEvent.touchStart(body, { touches: [{ identifier: 1, clientY: 160 }] });
    fireEvent.touchMove(body, { touches: [{ identifier: 1, clientY: 80 }] });
    clock.mockReturnValue(500);
    fireEvent.touchEnd(body, {
      touches: [],
      changedTouches: [{ identifier: 1, clientY: 80 }],
    });
    clock.mockReturnValue(600);
    body.scrollTop = 670;
    for (const observer of FakeResizeObserver.all) observer.fire(body);
    expect(body.scrollTop).toBe(590);
    expect(captured()).toEqual({ kind: "scroll", top: 590 });
    expect(onUserScroll).not.toHaveBeenCalled();
  });

  it("updates a blocked touch coordinate without admitting its distance later", () => {
    scriptGeometry();
    stubResizeObserver();
    const onUserScroll = vi.fn();
    const { body, captured } = setup(
      { kind: "scroll", top: 590 },
      false,
      onUserScroll,
    );
    fireEvent.scroll(body);
    fireEvent.touchStart(body, { touches: [{ identifier: 1, clientY: 160 }] });
    const blocked = createEvent.touchMove(body, {
      cancelable: true,
      touches: [{ identifier: 1, clientY: 80 }],
    });
    blocked.preventDefault();
    fireEvent(body, blocked);
    fireEvent.touchMove(body, { touches: [{ identifier: 1, clientY: 80 }] });
    body.scrollTop = 670;
    fireEvent.scroll(body);
    for (const observer of FakeResizeObserver.all) observer.fire(body);
    expect(body.scrollTop).toBe(590);
    expect(captured()).toEqual({ kind: "scroll", top: 590 });
    expect(onUserScroll).not.toHaveBeenCalled();
  });

  it.each(["ctrl", "prevented"] as const)(
    "rejects %s wheel without erasing a pending key",
    (input) => {
      scriptGeometry();
      const onUserScroll = vi.fn();
      const { body, captured } = setup(
        { kind: "scroll", top: 590 },
        false,
        onUserScroll,
      );
      fireEvent.scroll(body);
      fireEvent.keyDown(body, { key: "PageDown" });
      const wheel = createEvent.wheel(body, {
        cancelable: true,
        deltaY: 80,
        ctrlKey: input === "ctrl",
      });
      if (input === "prevented") wheel.preventDefault();
      fireEvent(body, wheel);
      body.scrollTop = 670;
      fireEvent.scroll(body);
      expect(captured()).toMatchObject({ fallbackTop: 670 });
      expect(onUserScroll).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["release", "body"],
    ["cancel", "body"],
    ["release", "window"],
    ["cancel", "window"],
  ] as const)(
    "handles scrollbar %s at %s without renewing its established evidence",
    (end, target) => {
      scriptGeometry();
      stubResizeObserver();
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      const onUserScroll = vi.fn();
      const { body, captured } = setup(
        { kind: "scroll", top: 590 },
        false,
        onUserScroll,
      );
      fireEvent.scroll(body);
      const pointer = {
        pointerId: 3,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
      };
      fireEvent.pointerDown(body, pointer);
      clock.mockReturnValue(100);
      body.scrollTop = 650;
      fireEvent.scroll(body);
      expect(captured()).toMatchObject({ fallbackTop: 650 });
      clock.mockReturnValue(200);
      if (end === "release")
        fireEvent.pointerUp(target === "body" ? body : window, pointer);
      else fireEvent.pointerCancel(target === "body" ? body : window, pointer);
      body.scrollTop = 670;
      fireEvent.scroll(body);
      for (const observer of FakeResizeObserver.all) observer.fire(body);
      expect(body.scrollTop).toBe(end === "release" ? 670 : 650);
      expect(captured()).toMatchObject({
        fallbackTop: end === "release" ? 670 : 650,
      });
      expect(onUserScroll).toHaveBeenCalledTimes(end === "release" ? 2 : 1);
      const saved = captured();
      clock.mockReturnValue(800);
      body.scrollTop = 700;
      fireEvent.scroll(body);
      for (const observer of FakeResizeObserver.all) observer.fire(body);
      expect(body.scrollTop).toBe(end === "release" ? 670 : 650);
      expect(captured()).toBe(saved);
    },
  );

  it("lets a follower's scrollbar drag end follow after its place was noted aside", () => {
    scriptGeometry();
    stubResizeObserver();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const onUserScroll = vi.fn();
    const { body, captured } = setup(null, false, onUserScroll, false);
    // The follow's own scroll: noted aside, no bookmark, no user scroll.
    body.scrollTop = 170;
    fireEvent.scroll(body);
    body.scrollTop = 180;
    fireEvent.scroll(body);
    expect(captured()).toBeNull();
    expect(onUserScroll).not.toHaveBeenCalled();
    const pointer = {
      pointerId: 5,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
    };
    fireEvent.pointerDown(body, pointer);
    clock.mockReturnValue(100);
    body.scrollTop = 260;
    fireEvent.scroll(body);
    clock.mockReturnValue(200);
    body.scrollTop = 320;
    fireEvent.scroll(body);
    expect(captured()).toMatchObject({ kind: "word" });
    expect(onUserScroll).toHaveBeenCalled();
  });

  it.each(["child", "secondary", "touch", "non-primary"] as const)(
    "does not admit a %s pointer as a scrollbar",
    (input) => {
      scriptGeometry();
      stubResizeObserver();
      const onUserScroll = vi.fn();
      const { body, captured } = setup(
        { kind: "scroll", top: 590 },
        false,
        onUserScroll,
      );
      fireEvent.scroll(body);
      const child = body.querySelector('[data-stop="30"]');
      if (!child) throw new Error("Expected word");
      fireEvent.pointerDown(input === "child" ? child : body, {
        pointerId: 3,
        pointerType: input === "touch" ? "touch" : "mouse",
        isPrimary: input !== "non-primary",
        button: input === "secondary" ? 2 : 0,
      });
      body.scrollTop = 670;
      fireEvent.scroll(body);
      for (const observer of FakeResizeObserver.all) observer.fire(body);
      expect(body.scrollTop).toBe(590);
      expect(captured()).toEqual({ kind: "scroll", top: 590 });
      expect(onUserScroll).not.toHaveBeenCalled();
    },
  );

  it("seeds a bound body at its actual committed position without a bookmark", () => {
    scriptGeometry();
    const descriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollTop",
    );
    if (!descriptor) throw new Error("Expected native scrollTop");
    let top = 400;
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    });
    try {
      const onUserScroll = vi.fn();
      const { body, captured } = setup(null, false, onUserScroll, false);
      fireEvent.wheel(body, { deltaY: 80 });
      expect(captured()).toBeNull();
      expect(onUserScroll).not.toHaveBeenCalled();
      body.scrollTop = 480;
      fireEvent.scroll(body);
      expect(captured()).toMatchObject({ fallbackTop: 480 });
      expect(onUserScroll).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(Element.prototype, "scrollTop", descriptor);
    }
  });

  it("pauses the actual GuestScript before a queued scroll and restores its reading place", () => {
    scriptGeometry();
    const onUserScroll = vi.fn();
    function Host({ shown, playing }: { shown: boolean; playing: number }) {
      const reading = useGuestReading();
      return shown ? (
        <GuestScript
          layout="desktop"
          turns={SCRIPT_TURNS}
          wordStarts={[]}
          playing={playing}
          onSeek={vi.fn()}
          onUserScroll={onUserScroll}
          reading={reading}
        />
      ) : null;
    }
    const { container, rerender } = render(<Host shown playing={0} />);
    const body = container.querySelector<HTMLElement>(".sys-script-body");
    if (!body) throw new Error("Expected actual guest body");
    body.scrollTop = 170;
    fireEvent.wheel(body, { deltaY: 170 });
    expect(
      screen.getByRole("button", { name: "Follow the playhead" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "Back to playhead" }),
    ).toBeVisible();
    expect(onUserScroll).toHaveBeenCalledOnce();
    rerender(<Host shown={false} playing={40} />);
    rerender(<Host shown playing={40} />);
    const restored = container.querySelector<HTMLElement>(".sys-script-body");
    if (!restored) throw new Error("Expected restored guest body");
    expect(restored.scrollTop).toBe(170);
    fireEvent.scroll(restored);
    expect(onUserScroll).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Back to playhead" }));
    expect(restored.scrollTop).toBe(708);
    expect(
      screen.getByRole("button", { name: "Follow the playhead" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.scroll(restored);
    expect(onUserScroll).toHaveBeenCalledOnce();
    fireEvent.wheel(restored, { deltaY: -108 });
    restored.scrollTop = 600;
    fireEvent.scroll(restored);
    expect(
      screen.getByRole("button", { name: "Follow the playhead" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(onUserScroll).toHaveBeenCalledTimes(2);
    fireEvent.click(
      screen.getByRole("button", { name: "Follow the playhead" }),
    );
    expect(restored.scrollTop).toBe(616);
    expect(
      screen.getByRole("button", { name: "Follow the playhead" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores retired observer targets after a body replacement", () => {
    scriptGeometry();
    stubResizeObserver();
    const { body, container, binding, captured, rerender } = setup({
      kind: "scroll",
      top: 590,
    });
    const observer = FakeResizeObserver.of(body);
    rerender(
      <ScriptPane
        turns={SCRIPT_TURNS}
        readingPosition={binding}
        status={{ kind: "loading" }}
      />,
    );
    rerender(<ScriptPane turns={SCRIPT_TURNS} readingPosition={binding} />);
    const current = container.querySelector<HTMLElement>(".sys-script-body");
    if (!current) throw new Error("Expected replacement body");
    expect(current).not.toBe(body);
    current.scrollTop = 0;
    observer.fire(body);
    expect(current.scrollTop).toBe(0);
    expect(captured()).toEqual({ kind: "scroll", top: 590 });
    FakeResizeObserver.of(current).fire(current);
    expect(current.scrollTop).toBe(590);
  });

  it.each([
    "handled word",
    "editable",
    "prevented",
    "ctrl",
    "alt",
    "meta",
    "unrelated",
  ] as const)("rejects %s keys as reading input", (input) => {
    scriptGeometry();
    stubResizeObserver();
    const onUserScroll = vi.fn();
    const { body, binding, captured, rerender } = setup(
      { kind: "scroll", top: 590 },
      false,
      onUserScroll,
    );
    if (input === "editable")
      rerender(
        <ScriptPane
          turns={SCRIPT_TURNS}
          readingPosition={binding}
          onUserScroll={onUserScroll}
          editing={{ start: 30, end: 30 }}
          renderEditor={() => <input aria-label="Fix word" />}
        />,
      );
    const word = body.querySelector('[data-stop="5"]');
    if (!word) throw new Error("Expected word stop");
    const target =
      input === "editable"
        ? screen.getByRole("textbox", { name: "Fix word" })
        : input === "handled word"
          ? word
          : body;
    const key = createEvent.keyDown(target, {
      bubbles: true,
      cancelable: true,
      key:
        input === "unrelated"
          ? "a"
          : input === "handled word"
            ? "End"
            : "PageDown",
      ctrlKey: input === "ctrl",
      altKey: input === "alt",
      metaKey: input === "meta",
    });
    if (input === "prevented") key.preventDefault();
    fireEvent(target, key);
    const saved = captured();
    body.scrollTop = 670;
    fireEvent.scroll(body);
    for (const observer of FakeResizeObserver.all) observer.fire(body);
    expect(body.scrollTop).toBe(590);
    expect(captured()).toBe(saved);
    expect(onUserScroll).not.toHaveBeenCalled();
  });

  it.each(["identifier mismatch", "multitouch"] as const)(
    "drops ambiguous touch evidence after %s",
    (input) => {
      scriptGeometry();
      stubResizeObserver();
      const onUserScroll = vi.fn();
      const { body, captured } = setup(
        { kind: "scroll", top: 590 },
        false,
        onUserScroll,
      );
      fireEvent.touchStart(body, {
        touches: [{ identifier: 1, clientY: 160 }],
      });
      fireEvent.touchMove(body, { touches: [{ identifier: 1, clientY: 80 }] });
      fireEvent.touchMove(body, {
        touches:
          input === "identifier mismatch"
            ? [{ identifier: 2, clientY: 60 }]
            : [
                { identifier: 1, clientY: 60 },
                { identifier: 2, clientY: 80 },
              ],
      });
      body.scrollTop = 670;
      fireEvent.scroll(body);
      for (const observer of FakeResizeObserver.all) observer.fire(body);
      expect(body.scrollTop).toBe(590);
      expect(captured()).toEqual({ kind: "scroll", top: 590 });
      expect(onUserScroll).not.toHaveBeenCalled();
    },
  );

  it("keeps the bound transcript accessible", async () => {
    const { container } = setup();
    await expectNoA11yViolations(container);
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
    fireEvent.wheel(body, { deltaY: 20 });
    act(() => {
      ref.current?.scrollToWord(30, "center");
    });
    fireEvent.scroll(body);

    expect(onUserScroll).not.toHaveBeenCalled();
    expect(body.scrollTop).toBe(508);
    fireEvent.wheel(body, { deltaY: 92 });
    body.scrollTop = 600;
    fireEvent.scroll(body);
    expect(onUserScroll).toHaveBeenCalledOnce();
  });
  it.each(["width", "font"] as const)(
    "does not carry layout-driven %s motion into a replacement pane",
    (reflow) => {
      const geometry = scriptGeometry();
      vi.spyOn(performance, "now").mockReturnValue(0);
      const onUserScroll = vi.fn();
      const { body, binding, captured, rerender, container } = setup(
        null,
        false,
        onUserScroll,
      );
      body.scrollTop = 590;
      fireEvent.wheel(body, { deltaY: 590 });
      fireEvent.scroll(body);
      const saved = captured();
      expect(saved).toMatchObject({ index: 29, offset: -10, fallbackTop: 590 });

      geometry.setLineHeight(22);
      if (reflow === "width") geometry.resize(100, 200);
      body.scrollTop = 650;
      fireEvent(window, new Event("resize"));

      expect.soft(body.scrollTop).toBe(648);
      expect.soft(captured()).toBe(saved);
      expect.soft(onUserScroll).toHaveBeenCalledOnce();
      rerender(
        <ScriptPane
          turns={SCRIPT_TURNS}
          readingPosition={binding}
          status={{ kind: "loading" }}
        />,
      );
      rerender(<ScriptPane turns={SCRIPT_TURNS} readingPosition={binding} />);
      const replacement =
        container.querySelector<HTMLElement>(".sys-script-body");
      expect(replacement).not.toBe(body);
      expect(replacement?.scrollTop).toBe(648);
      expect(captured()).toBe(saved);
    },
  );

  it("does not let an old write acknowledgement swallow a new paging advance", () => {
    const geometry = scriptGeometry();
    geometry.setWordHeight(20);
    vi.spyOn(performance, "now").mockReturnValue(0);
    const onUserScroll = vi.fn();
    const { container } = render(
      <GuestScript
        layout="desktop"
        turns={SCRIPT_TURNS}
        wordStarts={[]}
        playing={34}
        onSeek={vi.fn()}
        onUserScroll={onUserScroll}
      />,
    );
    const body = container.querySelector<HTMLElement>(".sys-script-body");
    if (!body) throw new Error("Expected the actual guest Script body");
    fireEvent.click(
      screen.getByRole("button", { name: "Follow the playhead" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to playhead" }));
    expect(body.scrollTop).toBe(590);
    expect(
      screen.queryByRole("button", { name: "Back to playhead" }),
    ).toBeNull();

    body.scrollTop = 520;
    fireEvent.keyDown(body, { key: "PageDown" });
    body.scrollTop = 590;
    fireEvent.scroll(body);

    expect(onUserScroll).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Back to playhead" }),
    ).toBeVisible();
  });

  it.each(["blur", "hidden"] as const)(
    "retires an interrupted scrollbar press on %s",
    (interruption) => {
      scriptGeometry();
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      const onUserScroll = vi.fn();
      const { body, captured } = setup(
        { kind: "scroll", top: 590 },
        false,
        onUserScroll,
      );
      fireEvent.scroll(body);
      const saved = captured();
      fireEvent.pointerDown(body, {
        pointerId: 7,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
      });
      if (interruption === "blur") fireEvent(window, new Event("blur"));
      else {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        fireEvent(document, new Event("visibilitychange"));
      }
      clock.mockReturnValue(601);
      body.scrollTop = 670;
      fireEvent.scroll(body);
      fireEvent(window, new Event("resize"));

      expect(body.scrollTop).toBe(590);
      expect(captured()).toBe(saved);
      expect(onUserScroll).not.toHaveBeenCalled();
    },
  );

  it.each(["release", "cancel"] as const)(
    "observes the last held-scrollbar position on %s after its initial fact expires",
    (exit) => {
      scriptGeometry();
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      const onUserScroll = vi.fn();
      const { body, captured } = setup(
        { kind: "scroll", top: 590 },
        false,
        onUserScroll,
      );
      fireEvent.scroll(body);
      const saved = captured();
      fireEvent.pointerDown(body, {
        pointerId: 7,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
      });
      clock.mockReturnValue(600);
      body.scrollTop = 670;
      if (exit === "release") fireEvent.pointerUp(window, { pointerId: 7 });
      else fireEvent.pointerCancel(window, { pointerId: 7 });

      if (exit === "release") {
        expect(captured()).toMatchObject({ index: 33, fallbackTop: 670 });
        expect(onUserScroll).toHaveBeenCalledOnce();
      } else {
        expect(captured()).toBe(saved);
        expect(onUserScroll).not.toHaveBeenCalled();
      }
      const afterExit = captured();
      fireEvent.scroll(body);
      expect(captured()).toBe(afterExit);
      expect(onUserScroll).toHaveBeenCalledTimes(exit === "release" ? 1 : 0);
    },
  );
  it("does not let a stationary padding click claim later reflow", () => {
    const geometry = scriptGeometry();
    vi.spyOn(performance, "now").mockReturnValue(0);
    const onUserScroll = vi.fn();
    const { body, binding, captured, rerender, container } = setup(
      null,
      false,
      onUserScroll,
    );
    body.scrollTop = 590;
    fireEvent.wheel(body, { deltaY: 590 });
    fireEvent.scroll(body);
    const saved = captured();
    expect(saved).toMatchObject({ index: 29, offset: -10, fallbackTop: 590 });
    fireEvent.pointerDown(body, {
      pointerId: 17,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
    });
    fireEvent.pointerUp(window, { pointerId: 17 });
    geometry.setLineHeight(22);
    geometry.resize(100, 200);
    body.scrollTop = 670;
    fireEvent(window, new Event("resize"));
    expect.soft(body.scrollTop).toBe(648);
    expect.soft(captured()).toBe(saved);
    expect.soft(onUserScroll).toHaveBeenCalledOnce();
    rerender(
      <ScriptPane
        turns={SCRIPT_TURNS}
        readingPosition={binding}
        status={{ kind: "loading" }}
      />,
    );
    rerender(<ScriptPane turns={SCRIPT_TURNS} readingPosition={binding} />);
    expect(
      container.querySelector<HTMLElement>(".sys-script-body")?.scrollTop,
    ).toBe(648);
    expect(captured()).toBe(saved);
  });

  it.each(["key", "ended touch"] as const)(
    "keeps %s continuation across reflow that needs no restoration write",
    (input) => {
      const geometry = scriptGeometry();
      vi.spyOn(performance, "now").mockReturnValue(0);
      const onUserScroll = vi.fn();
      const { body, binding, captured, rerender, container } = setup(
        null,
        false,
        onUserScroll,
      );
      if (input === "key") fireEvent.keyDown(body, { key: "PageDown" });
      else {
        fireEvent.touchStart(body, {
          touches: [{ identifier: 17, clientY: 172 }],
        });
        fireEvent.touchMove(body, {
          touches: [{ identifier: 17, clientY: 152 }],
        });
      }
      body.scrollTop = 30;
      fireEvent.scroll(body);
      expect(captured()).toMatchObject({
        index: 1,
        offset: -10,
        fallbackTop: 30,
      });
      expect(onUserScroll).toHaveBeenCalledOnce();
      if (input === "ended touch")
        fireEvent.touchEnd(body, {
          touches: [],
          changedTouches: [{ identifier: 17, clientY: 152 }],
        });
      const firstStep = captured();
      geometry.resize(201, 200);
      fireEvent(window, new Event("resize"));
      expect(body.scrollTop).toBe(30);
      expect(captured()).toBe(firstStep);
      for (const [top, count] of [
        [74, 2],
        [368, 3],
      ]) {
        body.scrollTop = top;
        fireEvent.scroll(body);
        expect.soft(captured()).toMatchObject({ fallbackTop: top });
        expect.soft(onUserScroll).toHaveBeenCalledTimes(count);
      }
      rerender(
        <ScriptPane
          turns={SCRIPT_TURNS}
          readingPosition={binding}
          status={{ kind: "loading" }}
        />,
      );
      rerender(<ScriptPane turns={SCRIPT_TURNS} readingPosition={binding} />);
      expect(
        container.querySelector<HTMLElement>(".sys-script-body")?.scrollTop,
      ).toBe(368);
    },
  );
  it.each(["key", "ended touch"] as const)(
    "accepts a no-op Back before old %s motion and still admits fresh input",
    (input) => {
      const geometry = scriptGeometry();
      geometry.setWordHeight(20);
      vi.spyOn(performance, "now").mockReturnValue(0);
      const onUserScroll = vi.fn();
      const { container } = render(
        <GuestScript
          layout="desktop"
          turns={SCRIPT_TURNS}
          wordStarts={[]}
          playing={6}
          onSeek={vi.fn()}
          onUserScroll={onUserScroll}
        />,
      );
      const body = container.querySelector<HTMLElement>(".sys-script-body");
      if (!body) throw new Error("Expected actual guest body");
      if (input === "key") fireEvent.keyDown(body, { key: "PageDown" });
      else {
        fireEvent.touchStart(body, {
          touches: [{ identifier: 17, clientY: 172 }],
        });
        fireEvent.touchMove(body, {
          touches: [{ identifier: 17, clientY: 152 }],
        });
      }
      body.scrollTop = 30;
      fireEvent.scroll(body);
      if (input === "ended touch")
        fireEvent.touchEnd(body, {
          touches: [],
          changedTouches: [{ identifier: 17, clientY: 152 }],
        });
      expect(onUserScroll).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: "Back to playhead" }));
      expect(body.scrollTop).toBe(30);
      expect(
        screen.queryByRole("button", { name: "Back to playhead" }),
      ).toBeNull();
      body.scrollTop = 74;
      fireEvent.scroll(body);
      expect.soft(onUserScroll).toHaveBeenCalledOnce();
      expect
        .soft(screen.queryByRole("button", { name: "Back to playhead" }))
        .toBeNull();
      fireEvent.keyDown(body, { key: "PageDown" });
      body.scrollTop = 100;
      fireEvent.scroll(body);
      expect(onUserScroll).toHaveBeenCalledTimes(2);
      expect(
        screen.getByRole("button", { name: "Back to playhead" }),
      ).toBeVisible();
    },
  );

  it.each([
    ["key", "observer"],
    ["key", "scroll"],
    ["ended touch", "observer"],
    ["ended touch", "scroll"],
  ] as const)(
    "keeps %s motion already present in the first resized %s sample",
    (input, delivery) => {
      const geometry = scriptGeometry();
      stubResizeObserver();
      vi.spyOn(performance, "now").mockReturnValue(0);
      const onUserScroll = vi.fn();
      const { body, binding, captured, rerender, container } = setup(
        null,
        false,
        onUserScroll,
      );
      if (input === "key") fireEvent.keyDown(body, { key: "PageDown" });
      else {
        fireEvent.touchStart(body, {
          touches: [{ identifier: 17, clientY: 172 }],
        });
        fireEvent.touchMove(body, {
          touches: [{ identifier: 17, clientY: 152 }],
        });
      }
      body.scrollTop = 30;
      fireEvent.scroll(body);
      expect(captured()).toMatchObject({
        index: 1,
        offset: -10,
        fallbackTop: 30,
      });
      if (input === "ended touch")
        fireEvent.touchEnd(body, {
          touches: [],
          changedTouches: [{ identifier: 17, clientY: 152 }],
        });
      geometry.resize(201, 200);
      body.scrollTop = 74;
      if (delivery === "observer") FakeResizeObserver.of(body).fire(body);
      else fireEvent.scroll(body);
      expect.soft(body.scrollTop).toBe(74);
      expect.soft(captured()).toMatchObject({ fallbackTop: 74 });
      expect.soft(onUserScroll).toHaveBeenCalledTimes(2);
      body.scrollTop = 368;
      fireEvent.scroll(body);
      expect.soft(captured()).toMatchObject({ fallbackTop: 368 });
      expect.soft(onUserScroll).toHaveBeenCalledTimes(3);
      rerender(
        <ScriptPane
          turns={SCRIPT_TURNS}
          readingPosition={binding}
          status={{ kind: "loading" }}
        />,
      );
      rerender(<ScriptPane turns={SCRIPT_TURNS} readingPosition={binding} />);
      expect(
        container.querySelector<HTMLElement>(".sys-script-body")?.scrollTop,
      ).toBe(368);
    },
  );
  it.each(["observer-first", "release-first"] as const)(
    "does not lend a stationary held padding press to reflow delivered %s",
    (delivery) => {
      const geometry = scriptGeometry();
      vi.spyOn(performance, "now").mockReturnValue(0);
      const onUserScroll = vi.fn();
      const { body, binding, captured, rerender, container } = setup(
        null,
        false,
        onUserScroll,
      );
      body.scrollTop = 590;
      fireEvent.wheel(body, { deltaY: 590 });
      fireEvent.scroll(body);
      const saved = captured();
      expect(saved).toMatchObject({ index: 29, offset: -10, fallbackTop: 590 });
      fireEvent.pointerDown(body, {
        pointerId: 17,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
      });
      geometry.setLineHeight(22);
      geometry.resize(100, 200);
      body.scrollTop = 670;
      if (delivery === "observer-first") fireEvent(window, new Event("resize"));
      fireEvent.pointerUp(window, { pointerId: 17 });
      expect.soft(body.scrollTop).toBe(648);
      expect.soft(captured()).toBe(saved);
      expect.soft(onUserScroll).toHaveBeenCalledOnce();
      rerender(
        <ScriptPane
          turns={SCRIPT_TURNS}
          readingPosition={binding}
          status={{ kind: "loading" }}
        />,
      );
      rerender(<ScriptPane turns={SCRIPT_TURNS} readingPosition={binding} />);
      expect(
        container.querySelector<HTMLElement>(".sys-script-body")?.scrollTop,
      ).toBe(648);
      expect(captured()).toBe(saved);
    },
  );

  it("returns Tab to the saved keyboard reading word without taking focus on remount", async () => {
    scriptGeometry();
    stubNativeFocusScroll();
    function Host({ shown }: { shown: boolean }) {
      const reading = useGuestReading();
      return (
        <>
          <button type="button">Outside</button>
          {shown ? (
            <GuestScript
              guest="suggester"
              layout="desktop"
              turns={SCRIPT_TURNS}
              wordStarts={[]}
              playing={0}
              onSeek={vi.fn()}
              reading={reading}
            />
          ) : null}
        </>
      );
    }
    const { container, rerender } = render(<Host shown />);
    fireEvent.click(
      screen.getByRole("button", { name: "Follow the playhead" }),
    );
    const word = container.querySelector<HTMLElement>('[data-stop="15"]');
    if (!word) throw new Error("Expected keyboard reading word");
    await act(async () => {
      word.focus();
      await Promise.resolve();
    });
    expect(word.closest<HTMLElement>(".sys-script-body")?.scrollTop).toBe(116);
    rerender(<Host shown={false} />);
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();
    rerender(<Host shown />);
    expect(document.activeElement).toBe(outside);
    const body = container.querySelector<HTMLElement>(".sys-script-body");
    const returned = body?.querySelector('[data-stop="15"]');
    expect(body?.scrollTop).toBe(116);
    screen.getByRole("button", { name: "Follow the playhead" }).focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(returned);
    expect(body?.scrollTop).toBe(116);
    expect(
      screen.getByRole("button", { name: "Back to playhead" }),
    ).toBeVisible();
  });
  it.each(["observer-first", "release-first"] as const)(
    "does not pause empty-bookmark Follow for held-padding reflow delivered %s",
    (delivery) => {
      const geometry = scriptGeometry();
      const now = vi.spyOn(performance, "now").mockReturnValue(0);
      const onUserScroll = vi.fn();
      const { body, captured } = setup(null, false, onUserScroll, false);
      body.scrollTop = 170;
      fireEvent.scroll(body);
      expect(captured()).toBeNull();
      fireEvent.pointerDown(body, {
        pointerId: 17,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
      });
      now.mockReturnValue(700);
      geometry.resize(100, 200);
      body.scrollTop = 265;
      if (delivery === "observer-first") fireEvent(window, new Event("resize"));
      fireEvent.pointerUp(window, { pointerId: 17 });
      expect.soft(body.scrollTop).toBe(265);
      expect.soft(captured()).toBeNull();
      expect(onUserScroll).not.toHaveBeenCalled();
    },
  );

  it.each(["wheel", "key", "touch"] as const)(
    "does not credit a blocked %s at the new bottom for passive word anchoring",
    (input) => {
      const geometry = scriptGeometry();
      const saved: ScriptPaneReadingPosition = {
        kind: "word",
        index: 50,
        offset: 0,
        fallbackTop: 1000,
      };
      const onUserScroll = vi.fn();
      const { body, captured } = setup(saved, false, onUserScroll);
      fireEvent.scroll(body);
      expect(body.scrollTop).toBe(1000);
      if (input === "touch")
        fireEvent.touchStart(body, {
          touches: [{ identifier: 17, clientY: 170 }],
        });
      geometry.setLineHeight(22);
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
        1300,
      );
      body.scrollTop = 1100;
      if (input === "wheel") fireEvent.wheel(body, { deltaY: 100 });
      else if (input === "key") fireEvent.keyDown(body, { key: "PageDown" });
      else
        fireEvent.touchMove(body, {
          touches: [{ identifier: 17, clientY: 150 }],
        });
      fireEvent.scroll(body);
      fireEvent(window, new Event("resize"));
      expect.soft(body.scrollTop).toBe(1100);
      expect.soft(captured()).toBe(saved);
      expect(onUserScroll).not.toHaveBeenCalled();
    },
  );
  it.each(["key", "wheel", "touch"] as const)(
    "keeps pending %s across a clamped focus restore that writes no pixels",
    async (input) => {
      const geometry = scriptGeometry();
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
        790,
      );
      const onUserScroll = vi.fn();
      const { body, binding, captured, rerender, container } = setup(
        {
          kind: "word",
          index: 32,
          offset: 50,
          fallbackTop: 590,
          intent: "focus",
        },
        false,
        onUserScroll,
      );
      const word = body.querySelector<HTMLElement>('[data-stop="32"]');
      if (!word) throw new Error("Expected focused bottom word");
      await act(async () => {
        word.focus();
        await Promise.resolve();
      });
      expect(body.scrollTop).toBe(590);
      if (input === "key") fireEvent.keyDown(word, { key: "PageUp" });
      else if (input === "wheel") fireEvent.wheel(body, { deltaY: -30 });
      else {
        fireEvent.touchStart(body, {
          touches: [{ identifier: 17, clientY: 150 }],
        });
        fireEvent.touchMove(body, {
          touches: [{ identifier: 17, clientY: 170 }],
        });
      }
      geometry.setLineHeight(21);
      fireEvent(window, new Event("resize"));
      expect(body.scrollTop).toBe(590);
      expect(captured()).toMatchObject({
        index: 32,
        offset: 82,
        intent: "focus",
      });
      body.scrollTop = 560;
      fireEvent.scroll(body);
      expect.soft(captured()).toMatchObject({ fallbackTop: 560 });
      expect.soft(onUserScroll).toHaveBeenCalledOnce();
      rerender(
        <ScriptPane
          turns={SCRIPT_TURNS}
          readingPosition={binding}
          status={{ kind: "loading" }}
        />,
      );
      rerender(<ScriptPane turns={SCRIPT_TURNS} readingPosition={binding} />);
      expect(
        container.querySelector<HTMLElement>(".sys-script-body")?.scrollTop,
      ).toBe(560);
    },
  );
  it.each(["observer-first", "release-first"] as const)(
    "keeps actual Guest Follow on after empty-bookmark held reflow delivered %s",
    (delivery) => {
      const geometry = scriptGeometry();
      const now = vi.spyOn(performance, "now").mockReturnValue(0);
      const onUserScroll = vi.fn();
      const { container } = render(
        <GuestScript
          guest="suggester"
          layout="desktop"
          turns={SCRIPT_TURNS}
          wordStarts={[]}
          playing={17}
          onSeek={vi.fn()}
          onUserScroll={onUserScroll}
        />,
      );
      const body = container.querySelector<HTMLElement>(".sys-script-body");
      if (!body) throw new Error("Expected followed Guest body");
      expect(body.scrollTop).toBe(156);
      const follow = screen.getByRole("button", {
        name: "Follow the playhead",
      });
      expect(follow).toHaveAttribute("aria-pressed", "true");
      fireEvent.pointerDown(body, {
        pointerId: 17,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
      });
      now.mockReturnValue(700);
      geometry.resize(100, 200);
      body.scrollTop = 251;
      if (delivery === "observer-first") fireEvent(window, new Event("resize"));
      fireEvent.pointerUp(window, { pointerId: 17 });
      expect.soft(follow).toHaveAttribute("aria-pressed", "true");
      expect
        .soft(screen.queryByRole("button", { name: "Back to playhead" }))
        .toBeNull();
      expect(onUserScroll).not.toHaveBeenCalled();
    },
  );
  it.each(["key", "wheel", "touch"] as const)(
    "does not give blocked %s a prior upward range clamp in actual Guest Script",
    async (input) => {
      const geometry = scriptGeometry();
      const scrollHeight = vi
        .spyOn(HTMLElement.prototype, "scrollHeight", "get")
        .mockReturnValue(790);
      const onUserScroll = vi.fn();
      function Host({
        shown,
        playing = 32,
      }: {
        shown: boolean;
        playing?: number;
      }) {
        const reading = useGuestReading();
        return (
          <>
            <button type="button">Outside</button>
            {shown ? (
              <GuestScript
                guest="suggester"
                layout="desktop"
                turns={SCRIPT_TURNS}
                wordStarts={[]}
                playing={playing}
                onSeek={vi.fn()}
                onUserScroll={onUserScroll}
                reading={reading}
              />
            ) : null}
          </>
        );
      }
      const { container, rerender } = render(<Host shown />);
      const body = container.querySelector<HTMLElement>(".sys-script-body");
      if (!body) throw new Error("Expected Guest body");
      expect(body.scrollTop).toBe(456);
      body.scrollTop = 590;
      fireEvent.wheel(body, { deltaY: 134 });
      fireEvent.scroll(body);
      const word = body.querySelector<HTMLElement>('[data-stop="32"]');
      if (!word) throw new Error("Expected saved keyboard reading word");
      await act(async () => {
        word.focus();
        await Promise.resolve();
      });
      expect(body.scrollTop).toBe(590);
      onUserScroll.mockClear();
      if (input === "touch")
        fireEvent.touchStart(body, {
          touches: [{ identifier: 17, clientY: 170 }],
        });
      geometry.setLineHeight(18.5);
      scrollHeight.mockReturnValue(760);
      body.scrollTop = 560;
      if (input === "key") fireEvent.keyDown(word, { key: "PageDown" });
      else if (input === "wheel") fireEvent.wheel(body, { deltaY: 100 });
      else
        fireEvent.touchMove(body, {
          touches: [{ identifier: 17, clientY: 150 }],
        });
      fireEvent.scroll(body);
      fireEvent(window, new Event("resize"));
      expect.soft(onUserScroll).not.toHaveBeenCalled();
      expect.soft(body.scrollTop).toBe(542);
      rerender(<Host shown={false} playing={0} />);
      const outside = screen.getByRole("button", { name: "Outside" });
      outside.focus();
      rerender(<Host shown playing={0} />);
      expect(document.activeElement).toBe(outside);
      const returnedBody =
        container.querySelector<HTMLElement>(".sys-script-body");
      expect.soft(returnedBody?.scrollTop).toBe(542);
      screen.getByRole("button", { name: "Follow the playhead" }).focus();
      await userEvent.tab();
      expect(document.activeElement).toBe(
        returnedBody?.querySelector('[data-stop="32"]'),
      );
    },
  );
});
