import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createRef, StrictMode } from "react";
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
    captured: () => captured,
  };
}

function scriptGeometry(lineHeight = 20) {
  let currentLineHeight = lineHeight;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1200);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      if (this.classList.contains("sys-script-body"))
        return new DOMRect(0, 0, 200, 200);
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
  return { setLineHeight: (next: number) => (currentLineHeight = next) };
}

describe("ScriptPane reading position", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (fontsDescriptor)
      Object.defineProperty(document, "fonts", fontsDescriptor);
    else Reflect.deleteProperty(document, "fonts");
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
