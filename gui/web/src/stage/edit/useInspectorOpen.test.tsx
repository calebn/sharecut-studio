import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SELECTION_SURFACES,
  type SelectionKind,
  type SheetScreen,
} from "../../inspector/selectionSurface";
import { useDawStore } from "../../state/dawStore";
import { inspectKeyOf } from "../../state/selection";
import { clipRow, minimalProject, sampleTrack } from "../../test/fixtures";
import { stubMatchMedia } from "../../test/matchMedia";
import type { Selection } from "../../types/project";
import { type InspectorShell, useInspectorOpen } from "./useInspectorOpen";

const inspected = (selection: Selection) => ({
  selection,
  inspectorKey: inspectKeyOf(selection),
});

const clip = clipRow({ id: "c2", track_id: "host", timeline_start: 10 });

beforeEach(() => {
  stubMatchMedia(false);
  useDawStore.getState().hydrate(
    "/tmp/p.json",
    minimalProject({
      tracks: [sampleTrack({ id: "host" })],
      clips: { tracks: { host: [clip] }, clip_count: 1 },
    }),
    null,
  );
  useDawStore.setState({
    ...inspected({ kind: "clip", id: "c2", trackId: "host" }),
    selectionHit: { kind: "trim-in", id: "c2" },
    compactInspectorView: "peek",
    timelineDragging: false,
    rangeArmed: false,
    sessionRegion: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useInspectorOpen strip", () => {
  it("peeks only on the phone's lanes", () => {
    const phone = renderHook(() => useInspectorOpen("phone", "timeline"));
    expect(phone.result.current.strip?.props.className).toContain(
      "bottom-sheet--compact",
    );
    for (const shell of ["tablet", "desktop"] as const) {
      const { result } = renderHook(() => useInspectorOpen(shell, "timeline"));
      expect(result.current).toMatchObject({ open: true, strip: null });
    }
  });

  it("keeps the full Inspector for an automatic-reduction band, whose session lives in its body", () => {
    useDawStore.setState({
      ...inspected({
        kind: "bleedAttenuation",
        id: "c2",
        trackId: "host",
        regionKey: null,
      }),
      selectionHit: null,
    });
    const { result } = renderHook(() => useInspectorOpen("phone", "timeline"));
    expect(result.current).toMatchObject({ open: true, strip: null });
  });
});

describe("useInspectorOpen open state", () => {
  it("stays shut for a selection alone and opens on Inspect", () => {
    useDawStore.setState({ inspectorKey: null });
    const { result } = renderHook(() =>
      useInspectorOpen("desktop", "timeline"),
    );
    expect(result.current.open).toBe(false);
    act(() => useDawStore.getState().setInspectorOpen(true));
    expect(result.current.open).toBe(true);
    act(() =>
      useDawStore
        .getState()
        .setSelection({ kind: "clip", id: "c3", trackId: "host" }),
    );
    expect(result.current.open).toBe(false);
  });

  it("closes and keeps the selection", () => {
    const { result } = renderHook(() =>
      useInspectorOpen("desktop", "timeline"),
    );
    act(() => result.current.close());
    expect(useDawStore.getState().inspectorKey).toBeNull();
    expect(useDawStore.getState().selection).not.toBeNull();
  });

  it("clears the selection when the phone sheet is dismissed", () => {
    const { result } = renderHook(() => useInspectorOpen("phone", "timeline"));
    act(() => result.current.dismiss());
    expect(useDawStore.getState()).toMatchObject({
      inspectorKey: null,
      selection: null,
      rangeArmed: false,
    });
  });

  it("drops an armed range with its sheet", () => {
    useDawStore.setState({
      selection: null,
      inspectorKey: null,
      rangeArmed: true,
    });
    const { result } = renderHook(() => useInspectorOpen("tablet", "timeline"));
    expect(result.current.open).toBe(true);
    act(() => result.current.close());
    expect(useDawStore.getState().rangeArmed).toBe(false);
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

function isOpen(
  shell: InspectorShell,
  screen: SheetScreen,
  selection: Selection,
  rangeArmed = false,
): boolean {
  useDawStore.setState({ ...inspected(selection), rangeArmed });
  return renderHook(() => useInspectorOpen(shell, screen)).result.current.open;
}

describe("the Inspector opens by reading one table on the phone and the tablet", () => {
  it.each(
    KINDS.flatMap((kind) =>
      (["timeline", "text"] as const).map((screen) => [kind, screen] as const),
    ),
  )("opens %s on the %s surface the same way on both", (kind, screen) => {
    const selection = EVERY_KIND[kind];
    expect(isOpen("tablet", screen, selection)).toBe(
      isOpen("phone", screen, selection),
    );
  });

  it("opens a transcript range with the Script showing and a clip not", () => {
    expect(isOpen("tablet", "text", EVERY_KIND.transcriptRange)).toBe(true);
    expect(isOpen("tablet", "text", EVERY_KIND.clip)).toBe(false);
  });

  it("opens every kind over the lanes, and on the desktop whichever surface", () => {
    for (const kind of KINDS) {
      expect(isOpen("tablet", "timeline", EVERY_KIND[kind])).toBe(true);
      expect(isOpen("desktop", "text", EVERY_KIND[kind])).toBe(true);
    }
  });

  it("opens on an armed range alone on the phone and the tablet (#1793), not the desktop", () => {
    expect(isOpen("phone", "timeline", null, true)).toBe(true);
    expect(isOpen("tablet", "timeline", null, true)).toBe(true);
    expect(isOpen("desktop", "timeline", null, true)).toBe(false);
  });

  it("carries the range fields in the sheet for a range, an armed range and a tablet region", () => {
    const fields = (shell: InspectorShell) =>
      renderHook(() => useInspectorOpen(shell, "timeline")).result.current
        .rangeActionsInSheet;
    useDawStore.setState(inspected(EVERY_KIND.range));
    expect(fields("desktop")).toBe(true);
    useDawStore.setState(inspected(EVERY_KIND.transcriptRange));
    expect(fields("desktop")).toBe(false);
    expect(fields("phone")).toBe(true);
    useDawStore.setState({
      ...inspected(EVERY_KIND.track),
      sessionRegion: { start_sec: 1, end_sec: 2 },
    });
    expect(fields("tablet")).toBe(true);
    expect(fields("phone")).toBe(false);
  });
});
