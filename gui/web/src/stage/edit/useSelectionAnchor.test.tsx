import { act, renderHook, waitFor } from "@testing-library/react";
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

describe("words selection header exclusion", () => {
  const selection = {
    kind: "transcriptRange",
    trackId: "reference",
    startWordIndex: 3,
    endWordIndex: 3,
  } as const;

  it("uses the selected word's own Script header", () => {
    const root = document.createElement("div");
    root.innerHTML = `<section class="sys-script"><div class="sys-script-header" id="other"></div></section><section class="sys-script"><div class="sys-script-header" id="own"></div><button class="sys-script-word" data-word-key="reference::3"></button></section>`;
    const { result, rerender } = renderHook(
      ({ enabled }) => useSelectionAnchor(root, selection, enabled),
      { initialProps: { enabled: true } },
    );
    const header = root.querySelector("#own");
    expect(result.current.exclusion.ref.current).toBe(header);
    expect(result.current.moves).toContain(header);
    expect(result.current.exclusion.withinRef.current).toBe(root);
    rerender({ enabled: false });
    expect(result.current.exclusion.ref.current).toBeNull();
  });

  it("does not apply a Script header to a missing word's timeline fallback", () => {
    const root = document.createElement("div");
    root.innerHTML = `<section class="sys-script"><div class="sys-script-header"></div></section><div class="lane-row" data-track-id="reference" id="lane"></div>`;
    const { result } = renderHook(() =>
      useSelectionAnchor(root, selection, true),
    );
    expect(result.current.ref.current?.id).toBe("lane");
    expect(result.current.exclusion.ref.current).toBeNull();
  });

  it("keeps a headerless words anchor unconstrained", () => {
    const root = document.createElement("div");
    root.innerHTML = `<section class="sys-script"><button class="sys-script-word" data-word-key="reference::3" id="word"></button></section>`;
    const { result } = renderHook(() =>
      useSelectionAnchor(root, selection, true),
    );
    expect(result.current.ref.current?.id).toBe("word");
    expect(result.current.exclusion.ref.current).toBeNull();
  });

  it("refreshes a replaced header even when the selected word node is unchanged", async () => {
    const root = document.createElement("div");
    root.innerHTML = `<section class="sys-script"><div class="sys-script-header" id="old"></div><button class="sys-script-word" data-word-key="reference::3"></button></section>`;
    const { result } = renderHook(() =>
      useSelectionAnchor(root, selection, true),
    );
    const word = result.current.ref.current;
    const next = document.createElement("div");
    next.className = "sys-script-header";
    act(() => root.querySelector("#old")?.replaceWith(next));
    await waitFor(() =>
      expect(result.current.exclusion.ref.current).toBe(next),
    );
    expect(result.current.ref.current).toBe(word);
    expect(result.current.moves).toContain(next);
  });
});
