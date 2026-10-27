import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SELECTION_SURFACES,
  type SelectionKind,
  type SheetScreen,
} from "../../inspector/selectionSurface";
import { useDawStore } from "../../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../../test/fixtures";
import { stubMatchMedia } from "../../test/matchMedia";
import type { Selection } from "../../types/project";
import { useSelectionSheet } from "./useSelectionSheet";

const clip = clipRow({ id: "c2", track_id: "host", timeline_start: 10 });

beforeEach(() => {
  useDawStore.getState().hydrate(
    "/tmp/p.json",
    minimalProject({
      tracks: [sampleTrack({ id: "host" })],
      clips: { tracks: { host: [clip] }, clip_count: 1 },
    }),
    null,
  );
  useDawStore.setState({
    selection: { kind: "clip", id: "c2", trackId: "host" },
    selectionHit: { kind: "trim-in", id: "c2" },
    compactInspectorView: "peek",
    timelineDragging: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSelectionSheet placement", () => {
  it.each(["tablet", "phone"] as const)(
    "puts the %s shell's inspector in a column on a short wide touch screen",
    (shell) => {
      stubMatchMedia(true);
      const { result } = renderHook(() => useSelectionSheet(shell, "timeline"));
      expect(result.current).toMatchObject({
        open: true,
        placement: "column",
        compact: undefined,
        className: "",
      });
    },
  );

  it("opens the phone's and the tablet's timeline selection at the compact strip", () => {
    stubMatchMedia(false);
    const phone = renderHook(() => useSelectionSheet("phone", "timeline"))
      .result.current;
    expect(phone.placement).toBe("sheet");
    expect(phone.compact?.className).toContain("bottom-sheet--compact");
    expect(phone.className).toContain("bottom-sheet--inspector");
    const tablet = renderHook(() => useSelectionSheet("tablet", "timeline"))
      .result.current;
    expect(tablet.placement).toBe("sheet");
    expect(tablet.compact?.className).toContain("bottom-sheet--compact");
    expect(tablet.className).toContain("bottom-sheet--inspector");
  });

  it("gives an envelope selection no lane band in a column", () => {
    useDawStore.setState({
      selection: { kind: "envelope", trackId: "host" },
      selectionHit: null,
    });
    const media = stubMatchMedia(true);
    const { result } = renderHook(() =>
      useSelectionSheet("tablet", "timeline"),
    );
    expect(result.current.className).toBe("");
    act(() => media.setMatches(false));
    expect(result.current.className).toContain("bottom-sheet--lane-band");
  });

  it("changes shape as the phone rotates", () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useSelectionSheet("phone", "timeline"));
    expect(result.current.placement).toBe("sheet");
    act(() => media.setMatches(true));
    expect(result.current.placement).toBe("column");
    expect(result.current.open).toBe(true);
  });

  /** A short screen throughout; only the column query follows the rotation. */
  function stubRotation(column: boolean) {
    let wide = column;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return query.includes("pointer: coarse") ? wide : true;
      },
      addEventListener: (_t: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_t: string, cb: () => void) => listeners.delete(cb),
    }));
    return (next: boolean) => {
      wide = next;
      for (const cb of listeners) cb();
    };
  }

  it("keeps the full Inspector, not the peek strip, when the phone turns upright over the same selection", () => {
    const rotate = stubRotation(true);
    const { result } = renderHook(() =>
      useSelectionSheet("tablet", "timeline"),
    );
    expect(result.current.placement).toBe("column");
    act(() => rotate(false));
    expect(result.current.placement).toBe("sheet");
    expect(result.current.compact).toBeUndefined();
    expect(result.current.className).toContain("bottom-sheet--inspector");
    act(() => rotate(true));
    act(() => rotate(false));
    expect(result.current.compact).toBeUndefined();
  });

  it("opens the peek strip for a selection made after the Inspector went upright", () => {
    const rotate = stubRotation(true);
    const { result } = renderHook(() =>
      useSelectionSheet("tablet", "timeline"),
    );
    act(() => rotate(false));
    act(() => useDawStore.setState({ selection: null }));
    act(() =>
      useDawStore.setState({
        selection: { kind: "clip", id: "c2", trackId: "host" },
      }),
    );
    expect(result.current.compact?.className).toContain(
      "bottom-sheet--compact",
    );
  });

  it("starts as the peek strip when the phone is upright", () => {
    stubRotation(false);
    const { result } = renderHook(() =>
      useSelectionSheet("tablet", "timeline"),
    );
    expect(result.current.compact?.className).toContain(
      "bottom-sheet--compact",
    );
  });

  it("keeps the full Inspector for an automatic-reduction band, whose session lives in its body", () => {
    stubRotation(false);
    useDawStore.setState({
      selection: {
        kind: "bleedAttenuation",
        id: "c2",
        trackId: "host",
        regionKey: null,
      },
      selectionHit: null,
    });
    const { result } = renderHook(() => useSelectionSheet("phone", "timeline"));
    expect(result.current.open).toBe(true);
    expect(result.current.compact).toBeUndefined();
  });

  it("scrolls the picked band above the sheet it opens over it", () => {
    stubRotation(false);
    document.body.innerHTML = `
      <div class="timeline-scroll"><div class="marker-lane" style="position: sticky"></div>
        <div data-hit-kind="bleed-attenuation" data-hit-id="late_gate:0"></div></div>
      <div class="bottom-sheet-root"><div class="bottom-sheet bottom-sheet--inspector"></div></div>`;
    const place = (el: Element, top: number, bottom: number) => {
      el.getBoundingClientRect = () =>
        ({ top, bottom, left: 0, right: 360, height: bottom - top }) as DOMRect;
    };
    const scroller = document.querySelector<HTMLElement>(".timeline-scroll")!;
    place(scroller, 52, 700);
    place(document.querySelector(".marker-lane")!, 52, 96);
    place(document.querySelector("[data-hit-kind]")!, 500, 530);
    place(document.querySelector(".bottom-sheet-root")!, 0, 748);
    Object.defineProperty(
      document.querySelector(".bottom-sheet"),
      "offsetHeight",
      { value: 360 },
    );
    useDawStore.setState({
      selection: {
        kind: "bleedAttenuation",
        id: "c2",
        trackId: "host",
        regionKey: "late_gate:0",
      },
      selectionHit: null,
    });
    renderHook(() => useSelectionSheet("phone", "timeline"));
    expect(scroller.scrollTop).toBe(150);
    document.body.replaceChildren();
  });

  it("closes through the same handler in a column", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useSelectionSheet("phone", "timeline"));
    act(() => result.current.onClose());
    expect(useDawStore.getState().selection).toBeNull();
  });
});

const EVERY_KIND: Record<SelectionKind, NonNullable<Selection>> = {
  range: {
    kind: "range",
    target: {
      kind: "exact_range",
      intervals: [{ start: 1, end: 2 }],
      track_ids: ["host"],
      clips: [],
      media_seals: {},
    },
  },
  transcriptRange: {
    kind: "transcriptRange",
    trackId: "host",
    startWordIndex: 0,
    endWordIndex: 0,
  },
  clip: { kind: "clip", id: "c2", trackId: "host" },
  bleedAttenuation: {
    kind: "bleedAttenuation",
    id: "c2",
    trackId: "host",
    regionKey: null,
  },
  pending: { kind: "pending", id: "p1", trackId: "host" },
  applied: { kind: "applied", id: "a1" },
  track: { kind: "track", trackId: "host" },
  chapter: { kind: "chapter", id: "Intro", time: 3 },
  social: { kind: "social", id: "s1" },
  comment: { kind: "comment", id: "k1" },
  envelope: { kind: "envelope", trackId: "host" },
  envelopePoint: { kind: "envelopePoint", trackId: "host", pointId: "e1" },
};

const KINDS = Object.keys(SELECTION_SURFACES) as SelectionKind[];

function sheetOpen(
  shell: "phone" | "tablet",
  screen: SheetScreen,
  selection: Selection,
  rangeArmed = false,
): boolean {
  useDawStore.setState({ selection, rangeArmed });
  return renderHook(() => useSelectionSheet(shell, screen)).result.current.open;
}

describe("the selection sheet opens by reading one table on the phone and the tablet", () => {
  it.each(
    KINDS.flatMap((kind) =>
      (["timeline", "text"] as const).map((screen) => [kind, screen] as const),
    ),
  )("opens %s on the %s surface the same way on both", (kind, screen) => {
    const selection = EVERY_KIND[kind];
    expect(sheetOpen("tablet", screen, selection)).toBe(
      sheetOpen("phone", screen, selection),
    );
  });

  it("opens a transcript range with the Script showing and a clip not", () => {
    expect(sheetOpen("tablet", "text", EVERY_KIND.transcriptRange)).toBe(true);
    expect(sheetOpen("tablet", "text", EVERY_KIND.clip)).toBe(false);
  });

  it("opens every kind over the lanes", () => {
    for (const kind of KINDS) {
      expect(sheetOpen("tablet", "timeline", EVERY_KIND[kind])).toBe(true);
    }
  });

  it("opens on an armed range alone on the phone and the tablet (#1793)", () => {
    expect(sheetOpen("phone", "timeline", null, true)).toBe(true);
    expect(sheetOpen("tablet", "timeline", null, true)).toBe(true);
  });

  it("keeps the sheet open on the range fields while tracks are ticked for an armed range", () => {
    const ticked: Selection = {
      kind: "track",
      trackId: "host",
      trackIds: ["host", "guest"],
    };
    expect(sheetOpen("tablet", "timeline", ticked, true)).toBe(true);
    expect(sheetOpen("tablet", "timeline", ticked, false)).toBe(true);
    expect(sheetOpen("phone", "timeline", ticked, true)).toBe(true);
  });
});
