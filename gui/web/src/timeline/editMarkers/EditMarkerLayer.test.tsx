import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setClipJoin } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { waitForDialogFocus } from "../../test/dialogFocus";
import { clipRow, minimalProject, sampleTrack } from "../../test/fixtures";
import {
  FakeResizeObserver,
  stubResizeObserver,
} from "../../test/resizeObserver";
import type { ClipRow } from "../../types/project";
import { effectiveMaxZoomPxPerSec } from "../../utils/timelineZoom.generated";
import { JoinEditor } from "../JoinEditor";
import { EditMarkerLayer } from "./EditMarkerLayer";
import { collectJoinMarks, planLaneMarks } from "./plan";

vi.mock("../../api", () => ({
  setClipJoin: vi.fn(async () => undefined),
}));
vi.mock("../WaveformLayer", () => ({ WaveformLayer: () => null }));

function pair(prefix: string, startSec: number, mode: ClipRow["join_in_mode"]) {
  const left = clipRow({
    id: `${prefix}0`,
    source_start: startSec - 5,
    source_end: startSec,
    timeline_start: startSec - 5,
    timeline_end: startSec,
  });
  const right = clipRow({
    id: `${prefix}1`,
    source_start: startSec,
    source_end: startSec + 5,
    timeline_start: startSec,
    timeline_end: startSec + 5,
    fade_in_ms: 10,
    join_left_clip_id: `${prefix}0`,
    join_in_mode: mode,
  });
  return { left, right };
}

function planOf(clips: ClipRow[], zoom: number) {
  return planLaneMarks(
    collectJoinMarks(clips, null, () => false),
    zoom,
    600,
  );
}

describe("EditMarkerLayer glyphs", () => {
  beforeEach(() => {
    useDawStore.setState({ openJoinId: null, joinMutationInFlight: false });
  });

  it.each([
    ["cut", "M6 1V11", "Cut"],
    ["fade", "M1 2L6 10L11 2", "Fade"],
    ["crossfade", "M1 1L11 11M11 1L1 11", "Crossfade"],
  ] as const)(
    "draws the %s glyph as a named button at the seam",
    async (mode, path, word) => {
      const { left, right } = pair("a", 2, mode);
      const { container } = render(
        <EditMarkerLayer
          plan={planOf([left, right], 50)}
          onZoomChip={vi.fn()}
        />,
      );
      const glyph = screen.getByRole("button", {
        name: new RegExp(`^${word}( \\d+ ms)? join at 0:02\\.0$`),
      });
      expect(glyph).toHaveClass("edit-mark", `edit-mark--${mode}`);
      expect(glyph).toHaveAttribute("data-hit-kind", "join");
      expect(glyph).toHaveAttribute("data-hit-id", "a1");
      expect(glyph.style.left).toBe("100px");
      expect(container.querySelector("svg path")?.getAttribute("d")).toBe(path);
      expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
        "true",
      );
      await expectNoA11yViolations(container);
    },
  );

  it("marks a blocked crossfade in its class and name", async () => {
    const { left, right } = pair("a", 2, "crossfade");
    const blocked = { ...right, join_crossfade_blocked: "no_fade_in" as const };
    const { container } = render(
      <EditMarkerLayer
        plan={planOf([left, blocked], 50)}
        onZoomChip={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Crossfade join at 0:02.0, will not blend",
      }),
    ).toHaveClass("edit-mark--blocked");
    await expectNoA11yViolations(container);
  });

  it("opens its join's popover on click and closes it on a second click", async () => {
    const { left, right } = pair("a", 2, "fade");
    render(
      <EditMarkerLayer plan={planOf([left, right], 50)} onZoomChip={vi.fn()} />,
    );
    const glyph = screen.getByRole("button", {
      name: "Fade 10 ms join at 0:02.0",
    });
    expect(glyph).toHaveAttribute("aria-haspopup", "dialog");
    expect(glyph).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(glyph);
    expect(useDawStore.getState().openJoinId).toBe("a1");
    expect(glyph).toHaveAttribute("aria-expanded", "true");
    expect(glyph).toHaveAttribute("aria-controls", "join-popover-a1");
    fireEvent.click(glyph);
    expect(useDawStore.getState().openJoinId).toBeNull();
  });

  it("leaves the open join alone while SetClipJoin is in flight", () => {
    const { left, right } = pair("a", 2, "fade");
    useDawStore.setState({ openJoinId: "a1", joinMutationInFlight: true });
    render(
      <EditMarkerLayer plan={planOf([left, right], 50)} onZoomChip={vi.fn()} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Fade 10 ms join at 0:02.0" }),
    );
    expect(useDawStore.getState().openJoinId).toBe("a1");
  });
});

describe("EditMarkerLayer tiers and labels", () => {
  beforeEach(() => {
    useDawStore.setState({ openJoinId: null, joinMutationInFlight: false });
  });

  const withLength = (right: ClipRow, ms: number): ClipRow => ({
    ...right,
    join_crossfade_ms: ms,
  });
  function widthOfLabels(px: number) {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(px);
  }

  it.each([
    [66, "narrow"],
    [200, "middle"],
    [1000, "wide"],
  ] as const)(
    "tiers the glyph of a 120 ms crossfade at %f px/s as %s",
    (zoom, tier) => {
      const { left, right } = pair("a", 2, "crossfade");
      render(
        <EditMarkerLayer
          plan={planOf([left, withLength(right, 120)], zoom)}
          onZoomChip={vi.fn()}
        />,
      );
      expect(
        screen.getByRole("button", { name: /^Crossfade.* join at 0:02\.0$/ }),
      ).toHaveAttribute("data-tier", tier);
    },
  );

  it("shows 'Crossfade 120 ms' beside a wide glyph, hidden from assistive tech and leading the glyph's name", async () => {
    widthOfLabels(90);
    const { left, right } = pair("a", 2, "crossfade");
    const { container } = render(
      <EditMarkerLayer
        plan={planOf([left, withLength(right, 120)], 1000)}
        onZoomChip={vi.fn()}
      />,
    );
    const label = container.querySelector(".edit-mark-label");
    expect(label).toHaveTextContent("Crossfade 120 ms");
    expect(label).toHaveAttribute("aria-hidden", "true");
    expect(
      screen.getByRole("button", {
        name: "Crossfade 120 ms join at 0:02.0",
      }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("keeps the length in a crossfade's name when its label is not drawn", () => {
    const { left, right } = pair("a", 2, "crossfade");
    const { container } = render(
      <EditMarkerLayer
        plan={planOf([left, withLength(right, 120)], 200)}
        onZoomChip={vi.fn()}
      />,
    );
    expect(container.querySelector(".edit-mark-label")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Crossfade 120 ms join at 0:02.0" }),
    ).toBeInTheDocument();
  });

  it("draws no label on a crossfade below the wide tier", () => {
    const { left, right } = pair("a", 2, "crossfade");
    const { container } = render(
      <EditMarkerLayer
        plan={planOf([left, withLength(right, 120)], 200)}
        onZoomChip={vi.fn()}
      />,
    );
    expect(container.querySelector(".edit-mark-label")).toBeNull();
  });

  it("labels a cut and a fade with their length when room allows", () => {
    widthOfLabels(20);
    const cut = pair("a", 5, "cut");
    const fade = pair("b", 25, "fade");
    const { container } = render(
      <EditMarkerLayer
        plan={planOf([cut.left, cut.right, fade.left, fade.right], 20)}
        onZoomChip={vi.fn()}
      />,
    );
    const labels = [...container.querySelectorAll(".edit-mark-label")].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["Cut", "Fade 10 ms"]);
  });

  it.each([
    [60, 2],
    [61, 1],
  ] as const)(
    "gates a %f px label against the 60 px of room before the next mark: %i labels draw",
    (width, drawn) => {
      widthOfLabels(width);
      const a = pair("a", 5, "cut");
      const b = pair("b", 24, "cut");
      const { container } = render(
        <EditMarkerLayer
          plan={planOf([a.left, a.right, b.left, b.right], 4)}
          onZoomChip={vi.fn()}
        />,
      );
      expect(container.querySelectorAll(".edit-mark-label")).toHaveLength(
        drawn,
      );
    },
  );
});

describe("EditMarkerLayer label refit", () => {
  const fonts = new EventTarget();

  beforeEach(() => {
    useDawStore.setState({ openJoinId: null, joinMutationInFlight: false });
    stubResizeObserver();
    Object.defineProperty(document, "fonts", {
      value: fonts,
      configurable: true,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.documentElement.style.fontSize = "";
    Reflect.deleteProperty(document, "fonts");
  });

  function renderTwoCuts() {
    const a = pair("a", 5, "cut");
    const b = pair("b", 24, "cut");
    return render(
      <EditMarkerLayer
        plan={planOf([a.left, a.right, b.left, b.right], 4)}
        onZoomChip={vi.fn()}
      />,
    );
  }
  const drawn = (root: HTMLElement) =>
    root.querySelectorAll(".edit-mark-label").length;
  const fireEveryResize = () => {
    for (const observer of FakeResizeObserver.all) {
      observer.fire();
    }
  };
  const rootPx = () =>
    parseFloat(document.documentElement.style.fontSize || "16");

  it("refits the labels when the root font size changes at runtime", () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      () => (40 * rootPx()) / 16,
    );
    const { container } = renderTwoCuts();
    expect(drawn(container)).toBe(2);

    document.documentElement.style.fontSize = "32px";
    act(() => fireEveryResize());
    expect(drawn(container)).toBe(1);

    document.documentElement.style.fontSize = "16px";
    act(() => fireEveryResize());
    expect(drawn(container)).toBe(2);
  });

  it("refits the labels when a web font finishes loading", () => {
    let widthPx = 40;
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      () => widthPx,
    );
    const { container } = renderTwoCuts();
    expect(drawn(container)).toBe(2);

    widthPx = 80;
    act(() => {
      fonts.dispatchEvent(new Event("loadingdone"));
    });
    expect(drawn(container)).toBe(1);

    widthPx = 40;
    act(() => {
      fonts.dispatchEvent(new Event("loadingdone"));
    });
    expect(drawn(container)).toBe(2);
  });

  it("refits once at mount when fonts are still loading, so an early load is not missed", () => {
    Object.defineProperty(fonts, "status", {
      value: "loading",
      configurable: true,
    });
    let reads = 0;
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      () => (++reads <= 2 ? 40 : 80),
    );
    const { container } = renderTwoCuts();
    expect(drawn(container)).toBe(1);
    Reflect.deleteProperty(fonts, "status");
  });
});

describe("EditMarkerLayer chips", () => {
  beforeEach(() => {
    useDawStore.setState({ openJoinId: null, joinMutationInFlight: false });
  });

  function threeJoins(gapSec = 0.1) {
    const first = clipRow({
      id: "c0",
      source_end: 1,
      timeline_end: 1,
    });
    const rows: ClipRow[] = [first];
    const modes: ClipRow["join_in_mode"][] = ["cut", "cut", "crossfade"];
    modes.forEach((mode, i) => {
      const at = 1 + i * gapSec;
      rows.push(
        clipRow({
          id: `c${i + 1}`,
          source_start: at,
          source_end: at + gapSec,
          timeline_start: at,
          timeline_end: at + gapSec,
          join_left_clip_id: `c${i}`,
          join_in_mode: mode,
        }),
      );
    });
    return rows;
  }

  it("names the group by count and type, and zooms to its span on click", async () => {
    const onZoomChip = vi.fn();
    const plan = planOf(threeJoins(), 10);
    expect(plan.chips).toHaveLength(1);
    expect(plan.symbols).toHaveLength(0);
    const { container } = render(
      <EditMarkerLayer plan={plan} onZoomChip={onZoomChip} />,
    );
    const chip = screen.getByRole("button", {
      name: "3 edits: 2 cuts, 1 crossfade. Zoom in",
    });
    expect(chip).toHaveTextContent("3");
    expect(chip).toHaveAttribute("data-hit-kind", "edit-chip");
    await expectNoA11yViolations(container);
    fireEvent.click(chip);
    expect(onZoomChip).toHaveBeenCalledExactlyOnceWith(plan.chips[0]);
  });

  it("draws a chip that cannot split as a count with no button to press", async () => {
    const max = effectiveMaxZoomPxPerSec(600);
    const plan = planOf(threeJoins(0.0001), max);
    expect(plan.chips).toHaveLength(1);
    const { container } = render(
      <EditMarkerLayer plan={plan} onZoomChip={vi.fn()} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    const chip = screen.getByRole("img", {
      name: "3 edits: 2 cuts, 1 crossfade",
    });
    expect(chip).toHaveTextContent("3");
    expect(chip).not.toHaveAttribute("data-hit-kind");
    await expectNoA11yViolations(container);
  });

  it("moves focus to the first member's glyph when the zoom splits the chip", () => {
    const clips = threeJoins();
    const view = render(
      <EditMarkerLayer plan={planOf(clips, 10)} onZoomChip={vi.fn()} />,
    );
    const chip = screen.getByRole("button", { name: /^3 edits/ });
    chip.focus();
    fireEvent.click(chip);
    view.rerender(
      <EditMarkerLayer plan={planOf(clips, 300)} onZoomChip={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: /^3 edits/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Cut join at 0:01.0" }),
    ).toHaveFocus();
  });

  it("leaves focus alone when a plan changes with nothing focused", () => {
    const clips = threeJoins();
    const view = render(
      <EditMarkerLayer plan={planOf(clips, 10)} onZoomChip={vi.fn()} />,
    );
    view.rerender(
      <EditMarkerLayer plan={planOf(clips, 300)} onZoomChip={vi.fn()} />,
    );
    expect(document.body).toHaveFocus();
  });

  it("does not pull focus from the body to a mark that was gone when focus left it", () => {
    const clips = threeJoins();
    const view = render(
      <EditMarkerLayer plan={planOf(clips, 300)} onZoomChip={vi.fn()} />,
    );
    screen.getByRole("button", { name: "Cut join at 0:01.1" }).focus();
    view.rerender(
      <EditMarkerLayer plan={planOf([], 300)} onZoomChip={vi.fn()} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    document.body.focus();
    view.rerender(
      <EditMarkerLayer plan={planOf(clips, 300)} onZoomChip={vi.fn()} />,
    );
    expect(document.body).toHaveFocus();
  });

  it("moves focus to the chip a focused glyph merges into on zoom out", () => {
    const clips = threeJoins();
    const view = render(
      <EditMarkerLayer plan={planOf(clips, 300)} onZoomChip={vi.fn()} />,
    );
    const glyph = screen.getByRole("button", { name: "Cut join at 0:01.1" });
    glyph.focus();
    view.rerender(
      <EditMarkerLayer plan={planOf(clips, 10)} onZoomChip={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: /^Cut join/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^3 edits/ })).toHaveFocus();
  });

  it("moves focus to the nearest remaining mark when a focused chip goes inert", () => {
    const max = effectiveMaxZoomPxPerSec(600);
    const near = pair("a", 2, "cut");
    const pairs = [near.left, near.right];
    const triple = threeJoins(0.0001).map((clip) => ({
      ...clip,
      timeline_start: clip.timeline_start + 100,
      timeline_end: clip.timeline_end + 100,
    }));
    const clips = [...pairs, ...triple];
    const live = planOf(clips, 20);
    expect(live.chips.map((chip) => chip.zoomTo == null)).toEqual([false]);
    const view = render(<EditMarkerLayer plan={live} onZoomChip={vi.fn()} />);
    screen.getByRole("button", { name: /^3 edits/ }).focus();
    const inert = planOf(clips, max);
    expect(inert.chips.map((chip) => chip.zoomTo)).toEqual([null]);
    view.rerender(<EditMarkerLayer plan={inert} onZoomChip={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^3 edits/ })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getAllByRole("button", { name: /join at/ })[0],
    );
  });

  it("renders glyphs and chips in one time-ordered sequence so Tab follows time", () => {
    const first = pair("a", 10, "cut");
    const last = pair("c", 30, "fade");
    const mid = threeJoins().map((clip) => ({
      ...clip,
      timeline_start: clip.timeline_start + 19,
      timeline_end: clip.timeline_end + 19,
    }));
    const { container } = render(
      <EditMarkerLayer
        plan={planOf(
          [first.left, first.right, ...mid, last.left, last.right],
          10,
        )}
        onZoomChip={vi.fn()}
      />,
    );
    const names = [...container.querySelectorAll("button")].map((el) =>
      el.getAttribute("aria-label"),
    );
    expect(names).toEqual([
      "Cut join at 0:10.0",
      "3 edits: 2 cuts, 1 crossfade. Zoom in",
      "Fade 10 ms join at 0:30.0",
    ]);
  });
});

describe("EditMarkerLayer with its join editors", () => {
  const a = pair("a", 5, "fade");
  const b = pair("b", 25, "fade");

  beforeEach(() => {
    useDawStore.getState().hydrate(
      "/tmp/ep.json",
      minimalProject({
        tracks: [sampleTrack()],
        clips: {
          tracks: { host: [a.left, a.right, b.left, b.right] },
          clip_count: 4,
        },
      }),
    );
    useDawStore.setState({ openJoinId: null, joinMutationInFlight: false });
    vi.mocked(setClipJoin).mockClear();
  });

  function Lane({ zoom = 50 }: { zoom?: number }) {
    const plan = planOf([a.left, a.right, b.left, b.right], zoom);
    return (
      <main className="timeline-area">
        {plan.symbols.map(({ mark }) => {
          const pairOf = mark.clipId === "a1" ? a : b;
          return (
            <JoinEditor
              key={mark.id}
              left={pairOf.left}
              right={pairOf.right}
              seamSec={pairOf.right.timeline_start}
              zoomPxPerSec={50}
              trackFadeMaxMs={null}
            />
          );
        })}
        <EditMarkerLayer plan={plan} onZoomChip={vi.fn()} />
      </main>
    );
  }

  it("opens and closes the popover, and closes on Escape with focus restored", async () => {
    const user = userEvent.setup();
    render(<Lane />);
    const [glyph] = screen.getAllByRole("button", {
      name: "Fade 10 ms join at 0:05.0",
    });
    await user.click(glyph);
    expect(glyph).toHaveAttribute("aria-expanded", "true");
    const dialog = screen.getByRole("dialog", { name: "Fade join at 0:05.0" });
    expect(glyph.getAttribute("aria-controls")).toBe(dialog.id);
    await user.click(glyph);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(glyph);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(glyph).toHaveFocus();
  });

  it("moves focus to the chip a join folds into while its popover holds focus", async () => {
    const user = userEvent.setup();
    const view = render(<Lane />);
    await user.click(
      screen.getByRole("button", { name: "Fade 10 ms join at 0:05.0" }),
    );
    await waitForDialogFocus();
    view.rerender(<Lane zoom={1} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /^2 edits/ })).toHaveFocus();
  });

  it("leaves focus alone when a join folds after its popover closed", async () => {
    const user = userEvent.setup();
    const view = render(<Lane />);
    const glyph = screen.getByRole("button", {
      name: "Fade 10 ms join at 0:05.0",
    });
    await user.click(glyph);
    await user.click(glyph);
    glyph.blur();
    view.rerender(<Lane zoom={1} />);
    expect(document.body).toHaveFocus();
  });

  it("has no axe violations while open", async () => {
    render(<Lane />);
    fireEvent.click(
      screen.getByRole("button", { name: "Fade 10 ms join at 0:05.0" }),
    );
    await expectNoA11yViolations(document.body);
  });

  it("keeps one popover open: opening another join by keyboard closes the first", async () => {
    const user = userEvent.setup();
    render(<Lane />);
    const first = screen.getByRole("button", {
      name: "Fade 10 ms join at 0:05.0",
    });
    const second = screen.getByRole("button", {
      name: "Fade 10 ms join at 0:25.0",
    });
    await user.click(first);
    await waitForDialogFocus();
    second.focus();
    await user.keyboard("{Enter}");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(second).toHaveAttribute("aria-expanded", "true");
  });

  it("closes the popover when the join unmounts", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Lane />);
    await user.click(
      screen.getByRole("button", { name: "Fade 10 ms join at 0:05.0" }),
    );
    expect(useDawStore.getState().openJoinId).toBe("a1");
    unmount();
    expect(useDawStore.getState().openJoinId).toBeNull();
  });

  it("does not close the popover from the glyph while SetClipJoin is in flight", async () => {
    vi.mocked(setClipJoin).mockImplementationOnce(() => new Promise(() => {}));
    const user = userEvent.setup();
    render(<Lane />);
    const glyph = screen.getByRole("button", {
      name: "Fade 10 ms join at 0:05.0",
    });
    await user.click(glyph);
    await user.click(screen.getByRole("button", { name: "Crossfade" }));
    await user.click(glyph);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens no other popover while SetClipJoin is in flight, so the failure shows", async () => {
    let reject: (e: Error) => void = () => {};
    vi.mocked(setClipJoin).mockImplementationOnce(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    const user = userEvent.setup();
    render(<Lane />);
    const first = screen.getByRole("button", {
      name: "Fade 10 ms join at 0:05.0",
    });
    const second = screen.getByRole("button", {
      name: "Fade 10 ms join at 0:25.0",
    });
    await user.click(first);
    await user.click(screen.getByRole("button", { name: "Crossfade" }));
    second.focus();
    await user.keyboard("{Enter}");
    expect(first).toHaveAttribute("aria-expanded", "true");
    expect(second).toHaveAttribute("aria-expanded", "false");
    await act(async () => {
      reject(new Error("nope"));
    });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await user.click(second);
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(second).toHaveAttribute("aria-expanded", "true");
  });
});
