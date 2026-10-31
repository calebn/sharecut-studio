import type { Page } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Reach, reachFailures } from "./reachability";

const page = {
  evaluate: async (callback: (arg: unknown) => Reach[], arg: unknown) =>
    callback(arg),
} as unknown as Page;

function geometry(
  element: HTMLElement,
  width = 24,
  height = 24,
  left = 10,
  top = 10,
) {
  Object.defineProperties(element, {
    offsetWidth: { configurable: true, value: width },
    offsetHeight: { configurable: true, value: height },
    scrollIntoView: { configurable: true, value: vi.fn() },
  });
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
    new DOMRect(left, top, width, height),
  );
}

describe("reachFailures size exemptions", () => {
  let pin: HTMLButtonElement;
  const elementFromPoint = vi.fn<() => Element | null>();

  beforeEach(() => {
    document.body.innerHTML =
      '<section class="canvas"><button class="sys-marker-hit">Comment</button></section>';
    pin = document.querySelector<HTMLButtonElement>(".sys-marker-hit")!;
    geometry(pin);
    elementFromPoint.mockReturnValue(pin);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: elementFromPoint,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "elementFromPoint");
    document.body.innerHTML = "";
  });

  it("reports a 24 px ordinary control below the floor", async () => {
    pin.className = "ordinary";
    expect(
      await reachFailures(page, { sizeExempt: [".sys-marker-hit"] }),
    ).toMatchObject([{ failure: "small", layout: { width: 24, height: 24 } }]);
  });

  it("waives only the matching pin's size", async () => {
    expect(await reachFailures(page)).toMatchObject([{ failure: "small" }]);
    expect(
      await reachFailures(page, { sizeExempt: [".sys-marker-hit"] }),
    ).toEqual([]);
  });

  it("still reports a covered pin", async () => {
    const cover = document.createElement("div");
    document.body.append(cover);
    elementFromPoint.mockReturnValue(cover);
    expect(
      await reachFailures(page, { sizeExempt: [".sys-marker-hit"] }),
    ).toMatchObject([{ failure: "covered" }]);
  });

  it("still reports a pin outside the viewport", async () => {
    geometry(pin, 24, 24, -10);
    expect(
      await reachFailures(page, { sizeExempt: [".sys-marker-hit"] }),
    ).toMatchObject([{ failure: "outside-viewport" }]);
  });

  it("still reports a pin outside its container", async () => {
    geometry(document.querySelector<HTMLElement>(".canvas")!, 20, 100, 0, 0);
    expect(
      await reachFailures(page, {
        scope: ".canvas",
        sizeExempt: [".sys-marker-hit"],
      }),
    ).toMatchObject([{ failure: "overflows-container" }]);
  });

  it("keeps the floor for an ordinary child of an exempt target", async () => {
    const child = document.createElement("a");
    child.href = "#edit";
    child.textContent = "Edit";
    pin.append(child);
    geometry(child);
    expect(
      await reachFailures(page, { sizeExempt: [".sys-marker-hit"] }),
    ).toMatchObject([{ failure: "small", control: 'a "Edit"' }]);
  });

  it("retains existing dense filtering for descendants and geometry", async () => {
    geometry(pin, 24, 24, -10);
    expect(await reachFailures(page, { dense: [".canvas"] })).toEqual([]);
  });
});
