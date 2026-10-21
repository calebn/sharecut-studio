import { afterEach, describe, expect, it } from "vitest";
import {
  claimTopLayerFloor,
  enterTopLayerPanel,
  showInTopLayer,
} from "./topLayerFloor";

function popover(log: string[], name: string): HTMLElement {
  const el = document.createElement("div");
  el.showPopover = () => {
    log.push(`show ${name}`);
  };
  el.hidePopover = () => {
    log.push(`hide ${name}`);
  };
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("top layer floor", () => {
  it("shows the toast region after a panel that opens while it is visible", () => {
    const log: string[] = [];
    const release = claimTopLayerFloor(popover(log, "toast"));
    expect(log).toEqual([]);
    const leave = enterTopLayerPanel();
    expect(log).toEqual(["show toast"]);
    leave();
    expect(log).toEqual(["show toast", "hide toast"]);
    release();
  });

  it("shows the region once claimed when a panel is already open", () => {
    const log: string[] = [];
    const leave = enterTopLayerPanel();
    const release = claimTopLayerFloor(popover(log, "toast"));
    expect(log).toEqual(["show toast"]);
    release();
    expect(log).toEqual(["show toast", "hide toast"]);
    leave();
  });

  it("re-shows the region for a second panel so it stays last", () => {
    const log: string[] = [];
    const release = claimTopLayerFloor(popover(log, "toast"));
    const first = enterTopLayerPanel();
    const second = enterTopLayerPanel();
    expect(log).toEqual(["show toast", "hide toast", "show toast"]);
    second();
    first();
    release();
  });

  it("is a popover only while a panel is open", () => {
    const region = popover([], "toast");
    const release = claimTopLayerFloor(region);
    expect(region.hasAttribute("popover")).toBe(false);
    const leave = enterTopLayerPanel();
    expect(region.getAttribute("popover")).toBe("manual");
    leave();
    expect(region.hasAttribute("popover")).toBe(false);
    release();
  });

  it("leaves the region alone without the Popover API", () => {
    const proto = HTMLElement.prototype as Partial<HTMLElement>;
    const { showPopover, hidePopover } = proto;
    delete proto.showPopover;
    delete proto.hidePopover;
    try {
      const region = document.createElement("div");
      const release = claimTopLayerFloor(region);
      const leave = enterTopLayerPanel();
      expect(region.hasAttribute("popover")).toBe(false);
      leave();
      release();
    } finally {
      proto.showPopover = showPopover;
      proto.hidePopover = hidePopover;
    }
  });

  it("ignores a region that left the document before a panel opened", () => {
    const log: string[] = [];
    const region = popover(log, "toast");
    const release = claimTopLayerFloor(region);
    region.remove();
    const leave = enterTopLayerPanel();
    leave();
    expect(log).toEqual([]);
    release();
  });

  it("does not hide a panel that left the document before it closed", () => {
    const log: string[] = [];
    const panel = popover(log, "panel");
    const close = showInTopLayer(panel);
    panel.remove();
    close();
    expect(log).toEqual(["show panel"]);
  });

  it("hides a panel that is still showing when it closes", () => {
    const log: string[] = [];
    const panel = popover(log, "panel");
    showInTopLayer(panel)();
    expect(log).toEqual(["show panel", "hide panel"]);
  });
});
