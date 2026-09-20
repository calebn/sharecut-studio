import { describe, expect, it } from "vitest";
import {
  anchorFractions,
  findPresenceAnchor,
  PRESENCE_ANCHOR_ATTR,
  presenceAnchor,
  presenceAnchorProps,
  resolvePresenceAnchor,
} from "./anchors";

describe("presenceAnchor", () => {
  it("sanitizes parts and stays within 96 chars", () => {
    expect(presenceAnchor("track", "Host Mic!")).toBe("track:host-mic-");
    expect(presenceAnchor("track", "host", "mute")).toBe("track:host:mute");
    expect(presenceAnchor("tab", "a".repeat(200)).length).toBe(96);
  });

  it("builds data attributes", () => {
    expect(presenceAnchorProps("audition:fx")).toEqual({
      [PRESENCE_ANCHOR_ATTR]: "audition:fx",
    });
  });

  it("walks up to the nearest ancestor", () => {
    const root = document.createElement("div");
    const btn = document.createElement("button");
    btn.setAttribute(PRESENCE_ANCHOR_ATTR, "track:host:mute");
    const inner = document.createElement("span");
    btn.appendChild(inner);
    root.appendChild(btn);
    expect(findPresenceAnchor(inner)?.id).toBe("track:host:mute");
    expect(resolvePresenceAnchor(root, "track:host:mute")).toBe(btn);
  });

  it("clamps fractions to 0..1", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "getBoundingClientRect", {
      value: () => ({ left: 10, top: 20, width: 100, height: 50 }),
    });
    expect(anchorFractions(el, 60, 45)).toEqual({ x: 0.5, y: 0.5 });
    expect(anchorFractions(el, -10, 200)).toEqual({ x: 0, y: 1 });
  });
});
