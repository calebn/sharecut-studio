import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeResizeObserver, stubResizeObserver } from "../test/resizeObserver";
import { type LaneMarker, MarkerLane } from "./MarkerLane";

const markers: readonly LaneMarker[] = [
  { kind: "comment", id: "a", start: 5, author: "Ada" },
  { kind: "comment", id: "b", start: 5, author: "Ben" },
  { kind: "comment", id: "c", start: 5, author: "Cy" },
  { kind: "comment", id: "d", start: 20, author: "Dee" },
  { kind: "comment", id: "e", start: 30, author: "Eli" },
];
let chipWidth = 32.40625;
let previousFont = "";

beforeEach(() => {
  chipWidth = 32.40625;
  previousFont = document.documentElement.style.fontSize;
  stubResizeObserver();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const scale =
        Number.parseFloat(document.documentElement.style.fontSize || "16px") /
        16;
      return new DOMRect(
        0,
        0,
        this.getAttribute("aria-label")?.includes("more markers")
          ? chipWidth * scale
          : 0,
        18,
      );
    },
  );
  const computed = globalThis.getComputedStyle;
  vi.stubGlobal(
    "getComputedStyle",
    (element: Element, pseudo?: string | null) => {
      const style = computed(element, pseudo);
      if (element.getAttribute("aria-label")?.includes("more markers")) {
        Object.defineProperties(style, {
          borderLeftWidth: { value: "1px", configurable: true },
          borderRightWidth: { value: "1px", configurable: true },
        });
      }
      return style;
    },
  );
});

afterEach(() => {
  document.documentElement.style.fontSize = previousFont;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const lane = (items = markers) => (
  <MarkerLane
    markers={items}
    authoritativeMarkers={items}
    start={0}
    pxPerSecond={304 / 60}
    width={304}
    duration={60}
    touch
    onSelect={() => undefined}
  />
);
const dee = () =>
  screen
    .getByRole("button", { name: /^Comment by Dee,/ })
    .closest<HTMLElement>(".sys-marker")!;
const reach = (element: HTMLElement) =>
  element.style.getPropertyValue("--sys-marker-reach-inline");

describe("marker target measurement", () => {
  it("retains current measurements through StrictMode layout cleanup and remount", () => {
    const view = render(<StrictMode>{lane()}</StrictMode>);
    expect(reach(dee())).toBe("-14px -14px");
    const chip = screen.getByRole("button", { name: "2 more markers" });
    expect(FakeResizeObserver.of(chip).disconnected).toBe(false);
    view.unmount();
    expect(FakeResizeObserver.all.every((item) => item.disconnected)).toBe(
      true,
    );
  });

  it("uses the intrinsic chip width during the initial layout commit", () => {
    render(lane());
    expect(reach(dee())).toBe("-14px -14px");
    const chip = screen.getByRole("button", { name: "2 more markers" });
    expect(FakeResizeObserver.of(chip).targets).toContain(chip);
  });

  it("remeasures count changes without replacing the menu trigger", async () => {
    const view = render(lane());
    const chip = screen.getByRole("button", { name: "2 more markers" });
    chipWidth = 35.40625;
    view.rerender(
      lane([...markers, { kind: "comment", id: "f", start: 5, author: "Fay" }]),
    );
    expect(screen.getByRole("button", { name: "3 more markers" })).toBe(chip);
    expect(reach(dee())).toBe("-14px -14px");
    const user = userEvent.setup();
    await user.click(chip);
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
    await user.keyboard("{Escape}");
    expect(chip).toHaveFocus();
  });

  it("updates font or container width changes through the existing button observer", () => {
    render(lane());
    const chip = screen.getByRole("button", { name: "2 more markers" });
    document.documentElement.style.fontSize = "20px";
    act(() => {
      FakeResizeObserver.of(chip).fire();
      FakeResizeObserver.of(
        document.querySelector<HTMLElement>(".sys-markers-rem")!,
      ).fire();
    });
    expect(reach(chip.closest<HTMLElement>(".sys-marker")!)).toBe("0px 0px");
    expect(reach(dee())).toBe("-12.99px -15.33px");
    document.documentElement.style.fontSize = "16px";
    chipWidth = 40;
    act(() => {
      FakeResizeObserver.of(chip).fire();
      FakeResizeObserver.of(
        document.querySelector<HTMLElement>(".sys-markers-rem")!,
      ).fire();
    });
    expect(reach(chip.closest<HTMLElement>(".sys-marker")!)).toBe("0px -5px");
    expect(reach(dee())).toBe("-14px -14px");
    chipWidth = 32.40625;
    act(() => FakeResizeObserver.of(chip).fire());
    expect(reach(chip.closest<HTMLElement>(".sys-marker")!)).toBe("0px -9px");
    expect(reach(dee())).toBe("-14px -14px");
  });

  it("lays a lane without chips out again when the root font size changes", () => {
    const { container } = render(lane(markers.slice(3)));
    expect(reach(dee())).toBe("-14px -14px");
    const probe = container.querySelector<HTMLElement>(".sys-markers-rem")!;
    document.documentElement.style.fontSize = "32px";
    act(() => FakeResizeObserver.of(probe).fire());
    expect(reach(dee())).toBe("-28px -9.33px");
  });

  it("discards removed chip metrics before the same IDs can return", () => {
    const view = render(lane());
    const chip = screen.getByRole("button", { name: "2 more markers" });
    const observer = FakeResizeObserver.of(chip);
    view.rerender(lane(markers.slice(3)));
    expect(observer.disconnected).toBe(true);
    chipWidth = 0;
    view.rerender(lane());
    expect(reach(dee())).toBe("-9px -14px");
    const returned = screen.getByRole("button", { name: "2 more markers" });
    chipWidth = 40;
    act(() => FakeResizeObserver.of(returned).fire());
    expect(reach(dee())).toBe("-14px -14px");
    view.unmount();
    expect(FakeResizeObserver.all.every((item) => item.disconnected)).toBe(
      true,
    );
  });
});
