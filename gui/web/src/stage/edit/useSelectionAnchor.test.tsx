import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { placeAnchoredExcluding } from "../../ui/anchoredPlacement";
import { useSelectionAnchor } from "./useSelectionAnchor";

const MARGIN = 8;

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

describe("transcript word keys shared by Edit and the guest transcript", () => {
  const selection = {
    kind: "transcriptRange",
    trackId: "reference",
    startWordIndex: 3,
    endWordIndex: 5,
  } as const;
  const rootOf = (html: string) => {
    const root = document.createElement("div");
    root.innerHTML = html;
    return root;
  };

  it("finds a guest word whose key carries the turn's ordinal in front", () => {
    const root = rootOf(
      `<section class="sys-script"><button class="sys-script-word" data-word-key="2:reference::3" id="guest"></button></section>`,
    );
    const { result } = renderHook(() =>
      useSelectionAnchor(root, selection, true),
    );
    expect(result.current.ref.current?.id).toBe("guest");
  });

  it("still finds an Edit-style key with no ordinal", () => {
    const root = rootOf(
      `<section class="sys-script"><button class="sys-script-word" data-word-key="reference::3" id="edit"></button></section>`,
    );
    const { result } = renderHook(() =>
      useSelectionAnchor(root, selection, true),
    );
    expect(result.current.ref.current?.id).toBe("edit");
  });

  it("takes the first match in document order when the suffix is ambiguous", () => {
    // Documented behaviour: `$=` matches every turn's word 3; querySelector
    // returns the first one in the document, not the one the user selected.
    const root = rootOf(
      `<section class="sys-script"><button class="sys-script-word" data-word-key="0:reference::3" id="first"></button><button class="sys-script-word" data-word-key="1:reference::3" id="second"></button></section>`,
    );
    const { result } = renderHook(() =>
      useSelectionAnchor(root, selection, true),
    );
    expect(result.current.ref.current?.id).toBe("first");
  });

  it("does not match a key that merely ends in the same digits", () => {
    const root = rootOf(
      `<section class="sys-script"><button class="sys-script-word" data-word-key="reference::13" id="other"></button></section>`,
    );
    const { result } = renderHook(() =>
      useSelectionAnchor(root, selection, true),
    );
    expect(result.current.ref.current?.id).not.toBe("other");
  });
});

describe("the box the header exclusion is judged within", () => {
  const selection = {
    kind: "transcriptRange",
    trackId: "reference",
    startWordIndex: 3,
    endWordIndex: 3,
  } as const;
  const html = `<section class="sys-script"><div class="sys-script-header"></div><button class="sys-script-word" data-word-key="reference::3"></button></section>`;

  it("defaults to the root, and takes `within` when one is given", () => {
    const root = document.createElement("div");
    root.innerHTML = html;
    const page = document.createElement("div");
    const byDefault = renderHook(() =>
      useSelectionAnchor(root, selection, true),
    );
    expect(byDefault.result.current.exclusion.withinRef.current).toBe(root);
    const given = renderHook(() =>
      useSelectionAnchor(root, selection, true, page),
    );
    expect(given.result.current.exclusion.withinRef.current).toBe(page);
  });

  it("keeps the bar inside the viewport when `within` is the whole page", () => {
    const box = (left: number, top: number, width: number, height: number) => ({
      left,
      top,
      right: left + width,
      bottom: top + height,
    });
    const viewport = { left: 0, top: 0, width: 390, height: 844 };
    const bar = { width: 104, height: 44 };
    const placed = placeAnchoredExcluding(
      box(243, 114, 38, 28),
      bar,
      viewport,
      box(8, 53, 374, 45),
      box(0, 0, 390, 844),
      { margin: MARGIN, gap: MARGIN, align: "center", prefer: "above" },
    );
    expect(placed.left).toBeGreaterThanOrEqual(8);
    expect(placed.left + bar.width).toBeLessThanOrEqual(390 - 8);
    expect(placed.side).toBe("below");
    expect(placed.top).toBeGreaterThanOrEqual(114 + 28);
  });
});
