import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSelectionAnchor } from "./useSelectionAnchor";

describe("comment selection anchor", () => {
  it("anchors to the comment's pin, not the whole timeline", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="timeline-area"><span id="pin" data-hit-kind="comment" data-hit-id="c1"></span></div>`;
    const { result } = renderHook(() =>
      useSelectionAnchor(root, { kind: "comment", id: "c1" }, true),
    );
    expect(result.current.ref.current?.id).toBe("pin");
  });

  it("falls back to the timeline when the pin is not drawn", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="timeline-area"></div>`;
    const { result } = renderHook(() =>
      useSelectionAnchor(root, { kind: "comment", id: "c1" }, true),
    );
    expect(result.current.ref.current?.className).toBe("timeline-area");
  });
});
