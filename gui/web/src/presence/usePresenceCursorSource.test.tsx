import { fireEvent, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { LANE_HEIGHT } from "../utils/layout";
import { PRESENCE_ANCHOR_ATTR } from "./anchors";
import { setPresenceCursorSink } from "./followSync";
import {
  presenceCursorFromPointer,
  usePresenceCursorSource,
} from "./usePresenceCursorSource";

function fakeRect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

describe("presenceCursorFromPointer", () => {
  it("uses lane_pos from the lanes stack when over a lane row", () => {
    const lanes = document.createElement("div");
    Object.defineProperty(lanes, "getBoundingClientRect", {
      value: () => fakeRect(0, 100, 400, 144),
    });
    const row = document.createElement("div");
    row.className = "lane-row";
    row.dataset.trackId = "b";
    const cursor = presenceCursorFromPointer(
      row,
      40,
      100 + 1.4 * LANE_HEIGHT,
      lanes,
      0,
      10,
      60,
    );
    expect(cursor?.track_id).toBe("b");
    expect(cursor?.lane_pos).toBeCloseTo(1.4, 2);
    expect(cursor?.t_sec).toBeTypeOf("number");
    expect(cursor?.anchor).toBeUndefined();
  });

  it("returns null below the last lane with no anchor", () => {
    const lanes = document.createElement("div");
    Object.defineProperty(lanes, "getBoundingClientRect", {
      value: () => fakeRect(0, 0, 400, 144),
    });
    const below = document.createElement("div");
    expect(
      presenceCursorFromPointer(below, 10, 200, lanes, 0, 10, 60),
    ).toBeNull();
  });

  it("uses an ancestor marker anchor when not on a lane", () => {
    const markers = document.createElement("div");
    markers.setAttribute(PRESENCE_ANCHOR_ATTR, "markers");
    Object.defineProperty(markers, "getBoundingClientRect", {
      value: () => fakeRect(0, 0, 100, 20),
    });
    const child = document.createElement("span");
    markers.appendChild(child);
    const cursor = presenceCursorFromPointer(child, 50, 10, null, 0, 10, 60);
    expect(cursor).toEqual({ anchor: "markers", x: 0.5, y: 0.5 });
  });

  it("centers on a mute button anchor", () => {
    const btn = document.createElement("button");
    btn.setAttribute(PRESENCE_ANCHOR_ATTR, "track:host:mute");
    Object.defineProperty(btn, "getBoundingClientRect", {
      value: () => fakeRect(0, 0, 40, 40),
    });
    expect(presenceCursorFromPointer(btn, 20, 20, null, 0, 10, 60)).toEqual({
      anchor: "track:host:mute",
      x: 0.5,
      y: 0.5,
    });
  });
});

function ShellProbe() {
  const rootRef = useRef<HTMLDivElement>(null);
  usePresenceCursorSource(rootRef);
  return (
    <div ref={rootRef} data-testid="shell">
      <button type="button" data-presence-anchor="track:guest:mute">
        M
      </button>
    </div>
  );
}

describe("usePresenceCursorSource", () => {
  afterEach(() => {
    setPresenceCursorSink(null);
  });

  it("publishes an anchor cursor after the shell node mounts", async () => {
    const seen: unknown[] = [];
    setPresenceCursorSink((cursor) => {
      seen.push(cursor);
    });
    const { getByRole } = render(<ShellProbe />);
    const btn = getByRole("button", { name: "M" });
    await waitFor(() => {
      fireEvent.pointerMove(btn, {
        clientX: 10,
        clientY: 10,
        pointerType: "mouse",
      });
      expect(
        seen.some(
          (c) => (c as { anchor?: string })?.anchor === "track:guest:mute",
        ),
      ).toBe(true);
    });
  });
});
