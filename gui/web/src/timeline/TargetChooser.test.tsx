import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import type { HitCandidate } from "./hitCandidates";
import type { ChooserView, HitRouter } from "./hitRouting";
import { hitTargetProps, type ResolvedHit } from "./hitTargets";
import { TargetChooser } from "./TargetChooser";

const fixtures: Element[] = [];

function target(attrs: Record<string, string>): Element {
  const clip = document.createElement("div");
  clip.className = "clip-block";
  clip.style.background = "var(--clip-dialogue-0)";
  const el = document.createElement("button");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  clip.append(el);
  document.body.append(clip);
  fixtures.push(clip);
  return el;
}

function hit(
  element: Element,
  c: Pick<HitCandidate, "kind" | "x"> & Partial<HitCandidate>,
): ResolvedHit {
  return {
    element,
    candidate: {
      id: "c",
      y: 112,
      distance: 1,
      priority: 4,
      selected: false,
      ...c,
    },
  };
}

let router: HitRouter;
let announce: ReturnType<typeof vi.fn<(message: string) => void>>;
let view: ChooserView;

beforeEach(() => {
  router = {
    dispose: vi.fn(),
    defers: vi.fn(() => false),
    longPress: vi.fn(),
    choose: vi.fn(),
    nextPage: vi.fn(),
    close: vi.fn(),
  };
  announce = vi.fn<(message: string) => void>();
  // jsdom does no layout: nothing is under any point.
  document.elementsFromPoint = () => [];
  useDawStore.setState({ announceStatus: announce });
  view = {
    origin: { x: 180, y: 400 },
    page: 0,
    fingerDown: true,
    over: null,
    hits: [
      hit(target(hitTargetProps("trim-in", "clip-b", 2)), {
        kind: "trim-in",
        x: 204,
      }),
      hit(
        target(
          hitTargetProps("envelope-point", "pt", 2, {
            selected: true,
            detail: "0.80",
          }),
        ),
        { kind: "envelope-point", x: 200, priority: 9, selected: true },
      ),
    ],
  };
});

afterEach(() => {
  cleanup();
  for (const el of fixtures.splice(0)) el.remove();
});

function show(overrides: Partial<ChooserView> = {}) {
  return render(
    <TargetChooser
      view={{ ...view, ...overrides }}
      router={router}
      bounds={{ left: 0, top: 0, right: 360, bottom: 800 }}
      closing={false}
      onClosed={() => undefined}
    />,
  );
}

describe("TargetChooser", () => {
  it("names each target by kind and time, in real-x order, and announces the count", () => {
    show();
    const menu = screen.getByRole("menu", { name: "Targets here" });
    const chips = screen.getAllByRole("menuitemradio");
    expect(menu).toContainElement(chips[0]);
    expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual([
      "Envelope point 0.80× at 00:02.000",
      "Trim start at 00:02.000",
    ]);
    expect(chips.map((c) => c.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
    ]);
    expect(chips[1]).toHaveStyle({
      "--chip-surface": "var(--clip-dialogue-0)",
    });
    expect(announce).toHaveBeenCalledWith("2 targets here");
    expect(chips[0]).toHaveTextContent("0.80×");
    expect(chips[1]).toHaveTextContent("");
  });

  it("captions the best-ranked chip, then the one under the finger", () => {
    const { rerender } = show();
    const caption = () =>
      document.querySelector(".target-chooser-caption")?.textContent;
    expect(caption()).toBe("Trim start · 00:02.000");
    rerender(
      <TargetChooser
        view={{ ...view, over: 1 }}
        router={router}
        bounds={{ left: 0, top: 0, right: 360, bottom: 800 }}
        closing={false}
        onClosed={() => undefined}
      />,
    );
    expect(caption()).toBe(
      "Envelope point 0.80× · 00:02.000Hold to drag · lift to select",
    );
  });

  it("marks only the chip under the held finger as about to grab", () => {
    const { rerender } = show({ over: 1 });
    const arming = () =>
      [...document.querySelectorAll(".target-chip.is-arming")].map((c) =>
        c.getAttribute("aria-label"),
      );
    expect(arming()).toEqual(["Envelope point 0.80× at 00:02.000"]);
    rerender(
      <TargetChooser
        view={{ ...view, over: 1, fingerDown: false }}
        router={router}
        bounds={{ left: 0, top: 0, right: 360, bottom: 800 }}
        closing={false}
        onClosed={() => undefined}
      />,
    );
    expect(arming()).toEqual([]);
    expect(document.querySelector(".target-chooser-hint")).toBeNull();
  });

  it("commits a chip by click (keyboard) and closes on Escape", () => {
    show();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Trim start/ }));
    expect(router.choose).toHaveBeenCalledWith(0, "virtual");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(router.close).toHaveBeenCalledOnce();
  });

  it("moves between chips with the arrow keys", async () => {
    show();
    await act(() => new Promise(requestAnimationFrame));
    const chips = screen.getAllByRole("menuitemradio");
    expect(chips[0]).toHaveFocus();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(chips[1]).toHaveFocus();
  });

  it("closes from a tap on the dimmed timeline", () => {
    show();
    const scrim = document.querySelector(".target-chooser-scrim");
    fireEvent.pointerDown(scrim as Element);
    expect(router.close).toHaveBeenCalledOnce();
  });

  it("pages past five targets with More", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      hit(target(hitTargetProps("chapter", `ch${i}`, i)), {
        kind: "chapter",
        x: i,
      }),
    );
    show({ hits: many });
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(4);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "More targets, 2 not shown" }),
    );
    expect(router.nextPage).toHaveBeenCalledOnce();
  });

  it("has no axe violations while open", async () => {
    show();
    await expectNoA11yViolations(
      document.querySelector(".target-chooser") as HTMLElement,
    );
  });
});
