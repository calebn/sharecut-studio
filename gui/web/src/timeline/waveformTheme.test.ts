import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWaveformFillCache, resolveWaveformFill } from "./waveformTheme";

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
