import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, sampleTrack } from "../test/fixtures";
import type { HitCandidate } from "./hitCandidates";
import type { ChooserView, HitRouter } from "./hitRouting";
import { hitTargetProps, type ResolvedHit } from "./hitTargets";
import { TimelineChooser } from "./TimelineChooser";

const fixtures: Element[] = [];
const bounds = { left: 0, top: 0, right: 360, bottom: 800 };

function target(attrs: Record<string, string>): Element {
  const el = document.createElement("button");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  fixtures.push(el);
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
    claimsClick: vi.fn(() => false),
    longPress: vi.fn(),
    choose: vi.fn(),
    openCreate: vi.fn(),
    close: vi.fn(),
    disarm: vi.fn(),
  };
  announce = vi.fn<(message: string) => void>();
  useDawStore.setState({
    announceStatus: announce,
    project: minimalProject({ tracks: [sampleTrack({ id: "host" })] }),
  });
  view = {
    origin: { x: 180, y: 400 },
    fingerDown: true,
    over: null,
    armed: false,
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

function tree(overrides: Partial<ChooserView> = {}) {
  return (
    <TimelineChooser
      view={{ ...view, ...overrides }}
      router={router}
      bounds={bounds}
    />
  );
}

function show(overrides: Partial<ChooserView> = {}) {
  return render(tree(overrides));
}

const chips = () => screen.getAllByRole("menuitem");
const caption = () =>
  document.querySelector(".edit-target-chooser-caption")?.textContent;

function chipFor(name: RegExp) {
  return screen.getByRole("menuitem", { name });
}

describe("TimelineChooser", () => {
  it("enters the top layer as a popover and leaves it on close", () => {
    const showPopover = vi.spyOn(HTMLElement.prototype, "showPopover");
    const hidePopover = vi.spyOn(HTMLElement.prototype, "hidePopover");
    const { unmount } = show();
    const layer = document.body.querySelector(".timeline-chooser-layer");
    expect(layer).not.toBeNull();
    expect(showPopover.mock.contexts).toContain(layer);
    unmount();
    expect(hidePopover.mock.contexts).toContain(layer);
    showPopover.mockRestore();
    hidePopover.mockRestore();
  });

  it("names each target by kind, name and time, in real-x order, and announces the count", () => {
    show();
    const menu = screen.getByRole("menu", { name: "Targets here, 2" });
    expect(menu).toContainElement(chips()[0]);
    expect(chips().map((c) => c.getAttribute("aria-label"))).toEqual([
      "Envelope point, 0.80× at 00:02.000, selected",
      "Clip, Trim start at 00:02.000",
    ]);
    expect(announce).toHaveBeenCalledWith("2 targets here", { toast: false });
    expect(chips().map((c) => c.getAttribute("aria-checked"))).toEqual([
      null,
      null,
    ]);
  });

  it("tells stacked comment pins apart by author", () => {
    const pins = ["Ada", "Ben"].map((author, i) =>
      hit(target(hitTargetProps("comment", `c${i}`, 5, { detail: author })), {
        kind: "comment",
        id: `c${i}`,
        x: 200 + i,
      }),
    );
    show({ hits: pins });
    expect(chips().map((c) => c.getAttribute("aria-label"))).toEqual([
      "Comment, Ada at 00:05.000",
      "Comment, Ben at 00:05.000",
    ]);
  });

  it("captions the chip under the finger, and the focused chip when none is", async () => {
    const { rerender } = show();
    await waitFor(() => expect(chips()[0]).toHaveFocus());
    expect(caption()).toBe("0.80× at 00:02.000, selected");
    rerender(tree({ over: 0 }));
    expect(caption()).toBe("Trim start at 00:02.000");
    rerender(tree({ over: null }));
    expect(caption()).toBe("0.80× at 00:02.000, selected");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(caption()).toBe("Trim start at 00:02.000");
  });

  it("draws no leader, arming ring, chevron or hint", () => {
    show({ over: 0, armed: true });
    expect(
      document.querySelector(".timeline-chooser-layer svg line"),
    ).toBeNull();
    expect(
      document.querySelector(
        ".is-arming, .target-chip-axis, .target-chooser-hint",
      ),
    ).toBeNull();
  });

  it("shows the five best-ranked of more, and says so", () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      hit(target(hitTargetProps("chapter", `ch${i}`, i)), {
        kind: "chapter",
        x: i,
      }),
    );
    show({ hits: many });
    expect(chips()).toHaveLength(5);
    expect(chips().map((c) => c.getAttribute("aria-label"))).toEqual(
      [0, 1, 2, 3, 4].map((i) => `Chapter, 00:0${i}.000`),
    );
    expect(
      screen.getByRole("menu", { name: "Targets here, showing 5 of 7" }),
    ).toBeVisible();
    expect(announce).toHaveBeenCalledWith("7 targets here, showing 5 of 7", {
      toast: false,
    });
  });

  it("never cuts the selected target, even as the second of its kind", () => {
    const kinds = [
      "trim-in",
      "roll",
      "pending-start",
      "comment",
      "chapter",
      "social-clip",
      "trim-out",
    ] as const;
    const many = kinds.map((kind, i) =>
      hit(target(hitTargetProps(kind, `k${i}`, i)), {
        kind,
        x: i * 10,
        selected: kind === "trim-out",
      }),
    );
    show({ hits: many });
    expect(chips().map((c) => c.getAttribute("aria-label"))).toEqual([
      "Clip, Trim start at 00:00.000",
      "Seam, Roll at 00:01.000",
      "Suggestion, Pending start at 00:02.000",
      "Comment, 00:03.000",
      "Clip, Trim end at 00:06.000, selected",
    ]);
  });

  it("commits a keyboard click as a virtual pick of the chip's hit index", () => {
    show();
    fireEvent.click(chipFor(/Trim start/));
    expect(router.choose).toHaveBeenCalledWith(0, "virtual");
  });

  it("commits a click that followed a pointer press with that pointer type", () => {
    show();
    const chip = chipFor(/Envelope point/);
    fireEvent.pointerDown(chip, { pointerType: "touch" });
    fireEvent.click(chip, { detail: 1 });
    expect(router.choose).toHaveBeenCalledWith(1, "touch");
  });

  it("treats a click with no press inside the chooser as assistive technology", () => {
    show();
    fireEvent.click(chipFor(/Envelope point/), { detail: 1 });
    expect(router.choose).toHaveBeenCalledWith(1, "virtual");
  });

  it("keeps the compat mousedown of a chip press from reaching the timeline", () => {
    show();
    const chip = chipFor(/Trim start/);
    expect(fireEvent.pointerDown(chip, { pointerType: "touch" })).toBe(false);
    const layer = document.querySelector(".timeline-chooser-layer");
    expect(fireEvent.pointerDown(layer as Element)).toBe(true);
  });

  it("commits once when the same chip is activated twice", () => {
    show();
    const chip = chipFor(/Trim start/);
    fireEvent.click(chip, { detail: 0 });
    fireEvent.click(chip, { detail: 0 });
    expect(router.choose).toHaveBeenCalledOnce();
  });

  it("closes on Escape and when focus leaves the fan, and not on a pick", async () => {
    show();
    await waitFor(() => expect(chips()[0]).toHaveFocus());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(router.close).toHaveBeenCalledOnce();
    vi.mocked(router.close).mockClear();
    cleanup();
    show();
    await waitFor(() => expect(chips()[0]).toHaveFocus());
    chips()[0].blur();
    expect(router.close).toHaveBeenCalledOnce();
    vi.mocked(router.close).mockClear();
    cleanup();
    show();
    fireEvent.click(chipFor(/Trim start/));
    expect(router.close).not.toHaveBeenCalled();
  });

  it("moves between chips with the arrow keys", async () => {
    show();
    await waitFor(() => expect(chips()[0]).toHaveFocus());
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(chips()[1]).toHaveFocus();
  });

  it("closes from a press on the dimmed timeline, and keeps the native menu from opening", () => {
    show();
    const scrim = document.querySelector(".timeline-create-scrim");
    fireEvent.pointerDown(scrim as Element);
    expect(router.close).toHaveBeenCalledOnce();
    expect(fireEvent.contextMenu(scrim as Element)).toBe(false);
  });

  it("has no axe violations while open", async () => {
    show();
    await expectNoA11yViolations(
      document.querySelector(".timeline-chooser-layer") as HTMLElement,
    );
  });
});
