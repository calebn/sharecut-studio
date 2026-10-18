import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { stubMatchMedia } from "../test/matchMedia";
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
    mobileMode: "timeline",
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
      const { result } = renderHook(() => useSelectionSheet(shell));
      expect(result.current).toMatchObject({
        open: true,
        placement: "column",
        compact: undefined,
        coversTools: false,
        className: "",
      });
    },
  );

  it("keeps the phone's compact strip and the tablet's sheet elsewhere", () => {
    stubMatchMedia(false);
    const phone = renderHook(() => useSelectionSheet("phone")).result.current;
    expect(phone.placement).toBe("sheet");
    expect(phone.compact?.className).toContain("bottom-sheet--compact");
    expect(phone.className).toContain("bottom-sheet--inspector");
    const tablet = renderHook(() => useSelectionSheet("tablet")).result.current;
    expect(tablet.placement).toBe("sheet");
    expect(tablet.compact).toBeUndefined();
    expect(tablet.className).toContain("bottom-sheet--inspector");
  });

  it("gives an envelope selection no lane band in a column", () => {
    useDawStore.setState({
      selection: { kind: "envelope", trackId: "host" },
      selectionHit: null,
    });
    const media = stubMatchMedia(true);
    const { result } = renderHook(() => useSelectionSheet("tablet"));
    expect(result.current.className).toBe("");
    act(() => media.setMatches(false));
    expect(result.current.className).toContain("bottom-sheet--lane-band");
  });

  it("changes shape as the phone rotates", () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useSelectionSheet("phone"));
    expect(result.current.placement).toBe("sheet");
    act(() => media.setMatches(true));
    expect(result.current.placement).toBe("column");
    expect(result.current.open).toBe(true);
  });

  it("closes through the same handler in a column", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useSelectionSheet("phone"));
    act(() => result.current.onClose());
    expect(useDawStore.getState().selection).toBeNull();
  });
});
