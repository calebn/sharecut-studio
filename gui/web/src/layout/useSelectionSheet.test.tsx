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
    const { result } = renderHook(() => useSelectionSheet("tablet"));
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
    const { result } = renderHook(() => useSelectionSheet("tablet"));
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
    const { result } = renderHook(() => useSelectionSheet("tablet"));
    expect(result.current.compact?.className).toContain(
      "bottom-sheet--compact",
    );
  });

  it("closes through the same handler in a column", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useSelectionSheet("phone"));
    act(() => result.current.onClose());
    expect(useDawStore.getState().selection).toBeNull();
  });
});
