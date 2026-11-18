import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeResizeObserver, stubResizeObserver } from "../test/resizeObserver";
import { Player, type PlayerProps } from "./Player";
import { findFitLevel, MAX_FIT_LEVEL } from "./useBarFit";

const base: PlayerProps = {
  form: "bar",
  time: "12:04.250",
  total: "52:10.000",
  playing: false,
  onPlayPause: () => undefined,
  hearMenu: { mode: "mix", onMode: () => undefined },
};

describe("findFitLevel", () => {
  it("is the lowest level at which the bar fits", () => {
    const asked: number[] = [];
    const level = findFitLevel((candidate) => {
      asked.push(candidate);
      return candidate >= 3;
    });
    expect(level).toBe(3);
    expect(asked).toEqual([0, 1, 2, 3]);
  });

  it("stays at 0 when the bar fits as it is, and measures once", () => {
    const fits = vi.fn(() => true);
    expect(findFitLevel(fits)).toBe(0);
    expect(fits).toHaveBeenCalledTimes(1);
  });

  it("gives up everything, and no more, when nothing fits", () => {
    const fits = vi.fn(() => false);
    expect(findFitLevel(fits)).toBe(MAX_FIT_LEVEL);
    expect(fits).toHaveBeenCalledTimes(MAX_FIT_LEVEL);
  });
});

describe("useBarFit", () => {
  let lowest = 0;
  const original = Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    lowest = 0;
    // A bar 400 px wide whose right column runs out of it until `lowest`
    // levels of the bar have been given up.
    Element.prototype.getBoundingClientRect = function rect(this: Element) {
      const host = this.closest<HTMLElement>(".sys-player-host");
      const level = Number(host?.dataset.fit ?? 0);
      const make = (left: number, width: number) =>
        ({
          left,
          right: left + width,
          width,
          height: 56,
          top: 0,
          bottom: 56,
          x: left,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      if (this.classList.contains("sys-player")) return make(0, 400);
      if (this.parentElement?.classList.contains("sys-player-left"))
        return make(8, 60);
      if (this.parentElement?.classList.contains("sys-player-center"))
        return make(180, 40);
      if (this.parentElement?.classList.contains("sys-player-right"))
        return make(level >= lowest ? 300 : 210, 40);
      return make(0, 0);
    };
    stubResizeObserver();
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = original;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const fit = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(".sys-player-host")?.dataset.fit;

  it("is fitted when the render returns, before any timer or frame could run", () => {
    vi.useFakeTimers();
    lowest = 3;
    const { container } = render(<Player {...base} />);
    expect(fit(container)).toBe("3");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts from level 0 again when what the bar holds changes", () => {
    lowest = 2;
    const { container, rerender } = render(<Player {...base} />);
    expect(fit(container)).toBe("2");
    lowest = 0;
    rerender(<Player {...base} solo="Rosa" />);
    expect(fit(container)).toBe("0");
  });

  it("fits again when the bar is resized", () => {
    lowest = 1;
    const { container } = render(<Player {...base} />);
    expect(fit(container)).toBe("1");
    lowest = 5;
    const host = container.querySelector<HTMLElement>(".sys-player-host");
    if (!host) throw new Error("no host");
    FakeResizeObserver.of(host).fire();
    expect(fit(container)).toBe("5");
  });

  it("fits again when the text size changes on <html>", async () => {
    lowest = 1;
    const { container } = render(<Player {...base} />);
    lowest = 4;
    document.documentElement.style.fontSize = "24px";
    await vi.waitFor(() => expect(fit(container)).toBe("4"));
    document.documentElement.style.fontSize = "";
  });

  it("fits again when the fonts finish loading", async () => {
    let loaded: () => void = () => undefined;
    const listeners: Record<string, () => void> = {};
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        ready: new Promise<void>((resolve) => {
          loaded = resolve;
        }),
        addEventListener: (event: string, listener: () => void) => {
          listeners[event] = listener;
        },
        removeEventListener: () => undefined,
      },
    });
    lowest = 1;
    const { container } = render(<Player {...base} />);
    expect(fit(container)).toBe("1");
    lowest = 3;
    loaded();
    await vi.waitFor(() => expect(fit(container)).toBe("3"));
    lowest = 5;
    listeners.loadingdone?.();
    expect(fit(container)).toBe("5");
    Reflect.deleteProperty(document, "fonts");
  });

  it("stays at level 0 where nothing has a layout", () => {
    Element.prototype.getBoundingClientRect = original;
    const { container } = render(<Player {...base} state="error" />);
    expect(fit(container)).toBe("0");
  });

  it("leaves the dock and the expanded form alone", () => {
    lowest = 3;
    const dock = render(<Player {...base} form="dock" />);
    expect(dock.container.querySelector("[data-fit]")).toBeNull();
    dock.unmount();
    const expanded = render(<Player {...base} form="expanded" />);
    expect(expanded.container.querySelector("[data-fit]")).toBeNull();
  });
});
