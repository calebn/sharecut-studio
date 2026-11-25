import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useAnchoredPanel } from "./useAnchoredPanel";

describe("useAnchoredPanel keeping clear of an element that moves by its style", () => {
  const roots: HTMLElement[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) root.remove();
  });

  const bar = (top: string) => {
    const el = document.createElement("div");
    el.className = "bar";
    el.style.top = top;
    el.getBoundingClientRect = () =>
      new DOMRect(450, Number.parseFloat(el.style.top), 200, 40);
    return el;
  };

  function setup() {
    const root = document.createElement("div");
    root.getBoundingClientRect = () => new DOMRect(0, 0, 1024, 768);
    const anchor = document.createElement("div");
    anchor.getBoundingClientRect = () => new DOMRect(500, 300, 100, 20);
    const panel = document.createElement("div");
    Object.defineProperty(panel, "offsetWidth", { value: 100 });
    Object.defineProperty(panel, "offsetHeight", { value: 40 });
    const first = bar("320px");
    root.append(anchor, first);
    document.body.append(root);
    roots.push(root);
    renderHook(() =>
      useAnchoredPanel(
        { current: panel },
        {
          reason: "The panel stays beside its subject.",
          ref: { current: anchor },
          exclusion: {
            elements: () => [root.querySelector(".bar")],
            withinRef: { current: root },
          },
        },
        true,
      ),
    );
    return { root, panel, first };
  }

  it("places the panel again when the bar moves out from under it", async () => {
    const { panel, first } = setup();
    expect(panel.style.top).toBe("368px");

    await act(async () => {
      first.style.top = "600px";
    });

    await waitFor(() => expect(panel.style.top).toBe("328px"));
  });

  it("follows a bar that was replaced after the panel placed itself", async () => {
    const { root, panel, first } = setup();
    const next = bar("320px");
    first.replaceWith(next);

    await act(async () => {
      next.style.top = "600px";
    });

    await waitFor(() => expect(panel.style.top).toBe("328px"));
    expect(root.contains(first)).toBe(false);
  });
});

describe("useAnchoredPanel with a rect source", () => {
  function place(anchorTop: number, rect?: () => DOMRect | null) {
    const anchor = document.createElement("div");
    anchor.getBoundingClientRect = () => new DOMRect(500, anchorTop, 100, 20);
    const panel = document.createElement("div");
    Object.defineProperty(panel, "offsetWidth", { value: 100 });
    Object.defineProperty(panel, "offsetHeight", { value: 40 });
    document.body.append(anchor, panel);
    renderHook(() =>
      useAnchoredPanel(
        { current: panel },
        {
          reason: "The panel stays beside its subject.",
          ref: { current: anchor },
          rect,
        },
        true,
      ),
    );
    anchor.remove();
    panel.remove();
    return panel;
  }

  it("places against the node's own rect without one", () => {
    expect(place(300).style.top).toBe("328px");
  });

  it("places against the given rect, not the node's", () => {
    const panel = place(300, () => new DOMRect(500, 100, 100, 20));
    expect(panel.style.top).toBe("128px");
  });

  it("keeps the panel on screen for an anchor far below it, placed by an edge point", () => {
    const panel = place(50_000, () => new DOMRect(500, 768, 0, 0));
    const top = Number.parseFloat(panel.style.top);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + 40).toBeLessThanOrEqual(768);
    expect(panel.style.visibility).not.toBe("hidden");
  });
});
