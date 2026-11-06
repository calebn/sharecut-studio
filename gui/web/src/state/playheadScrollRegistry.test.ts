import { describe, expect, it, vi } from "vitest";
import { playheadScrollRegistry } from "./playheadScrollRegistry";

describe("playheadScrollRegistry", () => {
  it("reports false with nothing registered", () => {
    expect(playheadScrollRegistry.scrollAllToPlayhead()).toBe(false);
  });

  it("calls every surface and reports true when any scrolled", () => {
    const script = vi.fn(() => false);
    const timeline = vi.fn(() => true);
    const offScript = playheadScrollRegistry.register("script", script);
    const offTimeline = playheadScrollRegistry.register("timeline", timeline);
    expect(playheadScrollRegistry.scrollAllToPlayhead()).toBe(true);
    expect(script).toHaveBeenCalledTimes(1);
    expect(timeline).toHaveBeenCalledTimes(1);
    offScript();
    offTimeline();
  });

  it("reports false when every surface declined", () => {
    const off = playheadScrollRegistry.register("timeline", () => false);
    expect(playheadScrollRegistry.scrollAllToPlayhead()).toBe(false);
    off();
  });

  it("stops calling a surface once it unregisters", () => {
    const scroll = vi.fn(() => true);
    playheadScrollRegistry.register("script", scroll)();
    expect(playheadScrollRegistry.scrollAllToPlayhead()).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("lets a stale unregister leave the replacement in place", () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const offFirst = playheadScrollRegistry.register("script", first);
    const offSecond = playheadScrollRegistry.register("script", second);
    offFirst();
    expect(playheadScrollRegistry.scrollAllToPlayhead()).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    offSecond();
  });
});
