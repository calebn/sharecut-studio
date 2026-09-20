import { describe, expect, it, vi } from "vitest";
import { registerReviewWebMcpTools } from "./webmcp";

describe("registerReviewWebMcpTools", () => {
  it("no-ops when modelContext is missing", () => {
    const cleanup = registerReviewWebMcpTools({
      playPause: vi.fn(),
      seek: vi.fn(),
      canComment: false,
      addComment: vi.fn(),
    });
    expect(typeof cleanup).toBe("function");
    cleanup();
  });

  it("registers tools when modelContext.registerTool exists", () => {
    const registerTool = vi.fn();
    Object.defineProperty(navigator, "modelContext", {
      configurable: true,
      value: { registerTool },
    });
    registerReviewWebMcpTools({
      playPause: vi.fn(),
      seek: vi.fn(),
      canComment: true,
      addComment: vi.fn(),
    });
    expect(registerTool).toHaveBeenCalled();
    const names = registerTool.mock.calls.map((c) => c[0].name);
    expect(names).toEqual(
      expect.arrayContaining(["play_pause", "seek_timeline", "add_comment"]),
    );
    Reflect.deleteProperty(navigator, "modelContext");
  });
});
