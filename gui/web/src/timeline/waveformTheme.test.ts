import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWaveformFillCache,
  clipWaveformFill,
  parseRgb,
  resolveWaveformFill,
  waveformStyle,
} from "./waveformTheme";

function clipCanvas(background: string): HTMLCanvasElement {
  const clip = document.createElement("div");
  clip.className = "clip-block";
  clip.style.background = background;
  const canvas = document.createElement("canvas");
  clip.appendChild(canvas);
  document.body.appendChild(clip);
  return canvas;
}

describe("resolveWaveformFill", () => {
  beforeEach(() => {
    clearWaveformFillCache();
    document.documentElement.style.setProperty(
      "--color-waveform-peak",
      "rgb(200, 200, 200)",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    document.documentElement.style.removeProperty("--color-waveform-peak");
  });

  it("reads styles once per (colour, theme), not per paint", () => {
    const style = vi.spyOn(window, "getComputedStyle");
    const a = clipCanvas("rgb(13, 126, 117)");
    const b = clipCanvas("rgb(13, 126, 117)");
    const first = resolveWaveformFill(a, "var(--clip-dialogue-0)", "dark");
    expect(first).toEqual({
      peak: "rgb(200, 200, 200)",
      core: "rgb(122, 184, 179)",
      edge: "rgb(187, 219, 216)",
    });
    const reads = style.mock.calls.length;
    expect(resolveWaveformFill(b, "var(--clip-dialogue-0)", "dark")).toEqual(
      first,
    );
    expect(style.mock.calls.length).toBe(reads);
  });

  it("resolves again for another theme or lane colour", () => {
    const style = vi.spyOn(window, "getComputedStyle");
    const canvas = clipCanvas("rgb(13, 126, 117)");
    resolveWaveformFill(canvas, "var(--clip-dialogue-0)", "dark");
    const reads = style.mock.calls.length;
    resolveWaveformFill(canvas, "var(--clip-dialogue-0)", "light");
    expect(style.mock.calls.length).toBeGreaterThan(reads);
    const afterTheme = style.mock.calls.length;
    resolveWaveformFill(canvas, "var(--clip-music)", "light");
    expect(style.mock.calls.length).toBeGreaterThan(afterTheme);
  });

  it("does not pin the flat fallback when the fill cannot be read yet", () => {
    const canvas = clipCanvas("transparent");
    expect(resolveWaveformFill(canvas, "var(--clip-sfx)", "dark")).toEqual({
      peak: "rgb(200, 200, 200)",
    });
    (canvas.parentElement as HTMLElement).style.background = "rgb(0, 0, 0)";
    expect(
      resolveWaveformFill(canvas, "var(--clip-sfx)", "dark").core,
    ).toBeDefined();
  });
});

describe("parseRgb / clipWaveformFill", () => {
  it("parse rgb() and color(srgb) fills", () => {
    expect(parseRgb("rgb(13, 126, 117)")).toEqual({
      rgb: [13, 126, 117],
      alpha: 1,
    });
    expect(parseRgb("color(srgb 1 0 0.5 / 50%)")).toEqual({
      rgb: [255, 0, 127.5],
      alpha: 0.5,
    });
    expect(parseRgb("oklch(0.5 0.1 180)")).toBeNull();
    expect(clipWaveformFill("rgb(13, 126, 117)")).toEqual({
      core: "rgb(122, 184, 179)",
      edge: "rgb(187, 219, 216)",
    });
  });
});

describe("waveformStyle", () => {
  it("resolves a color-mix peak token through a probe element", () => {
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      if (el === document.documentElement) {
        return {
          getPropertyValue: (name: string) =>
            name === "--color-waveform-peak"
              ? "color-mix(in srgb, var(--primitive-white) 55%, transparent)"
              : "",
        } as CSSStyleDeclaration;
      }
      if (
        el instanceof HTMLSpanElement &&
        el.parentElement === document.documentElement
      ) {
        return { color: "color(srgb 1 1 1 / 0.55)" } as CSSStyleDeclaration;
      }
      return real(el, pseudo);
    });
    const s = waveformStyle(
      clipLayer("transparent"),
      "var(--clip-sfx)",
      "dark",
    );
    expect([...s.core].map((v) => Math.round(v * 255))).toEqual([
      255, 255, 255, 140,
    ]);
    expect(s.edge[3]).toBeCloseTo(0.33, 6);
    expect(document.documentElement.querySelector(":scope > span")).toBeNull();
  });

  function clipLayer(background: string): HTMLElement {
    const clip = document.createElement("div");
    clip.className = "clip-block";
    clip.style.background = background;
    const layer = document.createElement("div");
    clip.appendChild(layer);
    document.body.appendChild(clip);
    return layer;
  }

  beforeEach(() => {
    clearWaveformFillCache();
    document.documentElement.style.setProperty(
      "--color-waveform-peak",
      "rgb(200, 200, 200)",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
    document.documentElement.style.removeProperty("--color-waveform-peak");
  });

  it("gives the lane's core and edge tints as RGBA floats, cached", () => {
    const style = vi.spyOn(window, "getComputedStyle");
    const layer = clipLayer("rgb(13, 126, 117)");
    const s = waveformStyle(layer, "var(--clip-dialogue-0)", "dark");
    expect([...s.core].map((v) => Math.round(v * 255))).toEqual([
      122, 184, 179, 255,
    ]);
    expect([...s.edge].map((v) => Math.round(v * 255))).toEqual([
      187, 219, 216, 255,
    ]);
    const reads = style.mock.calls.length;
    expect(
      waveformStyle(
        clipLayer("rgb(1, 2, 3)"),
        "var(--clip-dialogue-0)",
        "dark",
      ),
    ).toBe(s);
    expect(style.mock.calls.length).toBe(reads);
    expect(waveformStyle(layer, "var(--clip-dialogue-0)", "light")).not.toBe(s);
  });

  it("falls back to the peak colour, edge at 0.6 alpha, without caching", () => {
    const layer = clipLayer("transparent");
    const s = waveformStyle(layer, "var(--clip-sfx)", "dark");
    expect([...s.core].map((v) => Math.round(v * 255))).toEqual([
      200, 200, 200, 255,
    ]);
    expect(s.edge[3]).toBeCloseTo(0.6, 6);
    const later = clipLayer("rgb(13, 126, 117)");
    expect(waveformStyle(later, "var(--clip-sfx)", "dark")).not.toEqual(s);
  });

  it("is transparent when nothing parses yet", () => {
    document.documentElement.style.removeProperty("--color-waveform-peak");
    const s = waveformStyle(document.createElement("div"), "x", "dark");
    expect([...s.core, ...s.edge]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
