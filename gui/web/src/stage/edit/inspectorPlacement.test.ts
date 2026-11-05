import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInspectorPlacement,
  type InspectorPlacement,
} from "./inspectorPlacement";

const nodes: HTMLElement[] = [];
afterEach(() => {
  for (const node of nodes.splice(0)) node.remove();
  vi.restoreAllMocks();
});

function geometry(width = 1000) {
  const root = document.createElement("div");
  const anchor = document.createElement("div");
  const panel = document.createElement("div");
  root.append(anchor);
  document.body.append(root, panel);
  nodes.push(root, panel);
  const frame = vi
    .spyOn(root, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(10.2, 20.2, width, 800.2));
  const rect = vi
    .spyOn(anchor, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(100.7, 200.4, 120.4, 40.2));
  return {
    frame,
    rect,
    input: {
      root,
      anchorRef: { current: anchor },
      panel,
      revision: [],
      visible: true,
    },
  };
}

describe("Inspector placement DOM lease", () => {
  it("measures and notifies synchronously at actual connection, never at construction or bare attachment", () => {
    const target = geometry();
    let phase = "construct";
    const publish = vi.fn(() => {
      expect(phase).toBe("connect");
    });
    const owner = createInspectorPlacement(publish);
    owner.connect(target.input);
    expect(target.frame).not.toHaveBeenCalled();
    const stop = owner.attach();
    expect(target.frame).not.toHaveBeenCalled();
    try {
      phase = "connect";
      owner.connect(target.input);
      phase = "returned";
      expect(publish).toHaveBeenCalledExactlyOnceWith({
        bounds: { width: 1000, height: 800 },
        anchor: { x: 91, y: 180, width: 120, height: 40 },
      });
    } finally {
      stop();
    }
  });

  it("does not remeasure or reconnect for unchanged committed facts, but observes real revisions and visibility", () => {
    const target = geometry();
    const add = vi.spyOn(window, "addEventListener");
    const publish = vi.fn();
    const owner = createInspectorPlacement(publish);
    const stop = owner.attach();
    try {
      owner.connect(target.input);
      owner.connect({ ...target.input });
      owner.connect({ ...target.input });
      expect(target.frame).toHaveBeenCalledTimes(1);
      expect(add.mock.calls.filter(([name]) => name === "resize")).toHaveLength(
        1,
      );
      expect(publish).toHaveBeenCalledTimes(1);
      const revision: readonly unknown[] = [];
      owner.connect({ ...target.input, revision });
      expect(target.frame).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenCalledTimes(2);
      expect(publish.mock.calls[1]?.[0]).toBe(publish.mock.calls[0]?.[0]);
      owner.connect({ ...target.input, revision, visible: false });
      expect(target.frame).toHaveBeenCalledTimes(3);
      expect(publish).toHaveBeenCalledTimes(3);
      owner.connect({ ...target.input, revision, visible: true });
      expect(target.frame).toHaveBeenCalledTimes(4);
      expect(publish).toHaveBeenCalledTimes(4);
      expect(publish.mock.calls[3]?.[0]).toBe(publish.mock.calls[0]?.[0]);
    } finally {
      stop();
    }
  });

  it("redelivers equal cached geometry on a new connection when the receiver has not accepted a pending delivery", () => {
    const target = geometry();
    const display: { current: InspectorPlacement | null } = { current: null };
    let accept = true;
    const publish = vi.fn((snapshot: InspectorPlacement) => {
      if (accept) display.current = snapshot;
    });
    const owner = createInspectorPlacement(publish);
    const stop = owner.attach();
    try {
      owner.connect(target.input);
      expect(display.current).toMatchObject({ anchor: { y: 180 } });
      accept = false;
      target.rect.mockReturnValue(new DOMRect(100.7, 300.4, 120.4, 40.2));
      window.dispatchEvent(new Event("resize"));
      const pending = publish.mock.calls.at(-1)?.[0];
      expect(pending).toMatchObject({ anchor: { y: 280 } });
      expect(display.current).toMatchObject({ anchor: { y: 180 } });
      owner.connect({ ...target.input, root: null });
      expect(display.current).toMatchObject({ anchor: { y: 180 } });
      accept = true;
      owner.connect({ ...target.input, revision: [] });
      expect(display.current).toBe(pending);
      expect(publish.mock.calls.at(-1)?.[0]).toBe(pending);
      const delivered = publish.mock.calls.length;
      window.dispatchEvent(new Event("resize"));
      expect(publish).toHaveBeenCalledTimes(delivered);
    } finally {
      stop();
    }
  });

  it("keeps numeric placement while root is absent and redelivers the same object at reconnect", () => {
    const target = geometry();
    const publish = vi.fn();
    const owner = createInspectorPlacement(publish);
    const stop = owner.attach();
    try {
      owner.connect(target.input);
      owner.connect({ ...target.input, root: null });
      owner.measure();
      window.dispatchEvent(new Event("resize"));
      expect(target.frame).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(1);
      owner.connect(target.input);
      expect(target.frame).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenCalledTimes(2);
      expect(publish.mock.calls[1]?.[0]).toBe(publish.mock.calls[0]?.[0]);
    } finally {
      stop();
    }
  });

  it("ignores inner scrolling and measures actual outside scrolling, resize and canonical observer ingress", () => {
    const target = geometry();
    const publish = vi.fn();
    const owner = createInspectorPlacement(publish);
    const stop = owner.attach();
    try {
      owner.connect(target.input);
      target.rect.mockReturnValue(new DOMRect(100, 300, 120, 40));
      target.input.panel.dispatchEvent(new Event("scroll", { bubbles: true }));
      expect(target.frame).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(1);
      target.input.root.dispatchEvent(new Event("scroll", { bubbles: true }));
      expect(target.frame).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenCalledTimes(2);
      window.dispatchEvent(new Event("resize"));
      owner.measure();
      expect(target.frame).toHaveBeenCalledTimes(4);
      expect(publish).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it("retires old callbacks and stale attachment cleanup while replacement and replay connections stay live", () => {
    const a = geometry();
    const b = geometry(900);
    const add = vi.spyOn(window, "addEventListener");
    const publish = vi.fn();
    const owner = createInspectorPlacement(publish);
    const oldStop = owner.attach();
    owner.connect(a.input);
    const oldResize = add.mock.calls.find(([name]) => name === "resize")?.[1];
    const oldScroll = add.mock.calls.find(([name]) => name === "scroll")?.[1];
    if (typeof oldResize !== "function" || typeof oldScroll !== "function") {
      throw new Error("placement did not acquire both native listeners");
    }
    const stop = owner.attach();
    try {
      owner.connect(b.input);
      oldStop();
      oldResize(new Event("resize"));
      oldScroll(new Event("scroll"));
      expect(a.frame).toHaveBeenCalledTimes(1);
      expect(b.frame).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(2);
      window.dispatchEvent(new Event("resize"));
      expect(b.frame).toHaveBeenCalledTimes(2);
      stop();
      owner.measure();
      window.dispatchEvent(new Event("resize"));
      expect(b.frame).toHaveBeenCalledTimes(2);
      const replayStop = owner.attach();
      try {
        owner.connect(b.input);
        expect(b.frame).toHaveBeenCalledTimes(3);
        expect(publish).toHaveBeenCalledTimes(3);
        expect(publish.mock.calls[2]?.[0]).toBe(publish.mock.calls[1]?.[0]);
        window.dispatchEvent(new Event("resize"));
        expect(b.frame).toHaveBeenCalledTimes(4);
      } finally {
        replayStop();
      }
    } finally {
      stop();
    }
  });
});
