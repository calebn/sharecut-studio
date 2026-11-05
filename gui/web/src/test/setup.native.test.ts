import { afterAll, expect, it, vi } from "vitest";

const show = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "showPopover",
);
const hide = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "hidePopover",
);
const hitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
const popover = document.createElement("div");
const showPopover = vi.fn(function (this: HTMLElement) {
  this.dataset.nativePopover = "shown";
});
const elementFromPoint = vi.fn(function (this: Document) {
  return this.body;
});
Object.defineProperty(HTMLElement.prototype, "showPopover", {
  configurable: true,
  writable: true,
  value: showPopover,
});
Object.defineProperty(HTMLElement.prototype, "hidePopover", {
  configurable: true,
  writable: true,
  value: null,
});
Object.defineProperty(document, "elementFromPoint", {
  configurable: true,
  writable: true,
  value: elementFromPoint,
});
vi.resetModules();
await import("./setup");

afterAll(() => {
  if (show) Object.defineProperty(HTMLElement.prototype, "showPopover", show);
  if (hide) Object.defineProperty(HTMLElement.prototype, "hidePopover", hide);
  if (hitTest) Object.defineProperty(document, "elementFromPoint", hitTest);
  else Reflect.deleteProperty(document, "elementFromPoint");
});

it("preserves native popover and hit testing receivers and fills nullish methods", () => {
  popover.showPopover();
  expect(showPopover).toHaveBeenCalledOnce();
  expect(popover.dataset.nativePopover).toBe("shown");
  expect(document.elementFromPoint(0, 0)).toBe(document.body);
  expect(elementFromPoint).toHaveBeenCalledOnce();
  expect(popover.hidePopover()).toBeUndefined();
});
