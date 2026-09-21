import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import {
  initialPointerKind,
  pointerKindFromPointerType,
  usePointerType,
} from "./usePointerType";

function stubAnyPointerCoarse(matches: boolean): void {
  const matchMedia = vi.fn((query: string) => ({
    matches: query === "(any-pointer: coarse)" ? matches : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal("matchMedia", matchMedia);
}

function pointerDown(pointerType: string): void {
  act(() => {
    fireEvent.pointerDown(window, { pointerType });
  });
}

describe("pointerKindFromPointerType", () => {
  it("maps mouse and pen to fine", () => {
    expect(pointerKindFromPointerType("mouse")).toBe("fine");
    expect(pointerKindFromPointerType("pen")).toBe("fine");
  });

  it("maps touch to coarse", () => {
    expect(pointerKindFromPointerType("touch")).toBe("coarse");
  });

  it("returns null for empty or unknown values so the last kind is kept", () => {
    expect(pointerKindFromPointerType("")).toBeNull();
    expect(pointerKindFromPointerType(undefined)).toBeNull();
    expect(pointerKindFromPointerType(null)).toBeNull();
    expect(pointerKindFromPointerType("laser")).toBeNull();
  });
});

describe("initialPointerKind", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the any-pointer capability query", () => {
    stubAnyPointerCoarse(true);
    expect(initialPointerKind()).toBe("coarse");
    expect(window.matchMedia).toHaveBeenCalledWith("(any-pointer: coarse)");
  });

  it("is fine when the coarse capability does not match", () => {
    stubAnyPointerCoarse(false);
    expect(initialPointerKind()).toBe("fine");
  });

  it("falls back to fine without matchMedia", () => {
    expect(initialPointerKind()).toBe("fine");
  });
});

describe("usePointerType", () => {
  beforeEach(() => {
    useDawStore.setState({ pointerKind: "fine" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("initializes from the capability query before any pointer event", () => {
    stubAnyPointerCoarse(true);
    const { result } = renderHook(() => usePointerType());
    expect(result.current).toBe("coarse");
    expect(useDawStore.getState().pointerKind).toBe("coarse");
  });

  it("updates live on pointerdown: touch -> coarse, pen/mouse -> fine", () => {
    stubAnyPointerCoarse(false);
    const { result } = renderHook(() => usePointerType());
    expect(result.current).toBe("fine");

    pointerDown("touch");
    expect(result.current).toBe("coarse");

    pointerDown("pen");
    expect(result.current).toBe("fine");

    pointerDown("mouse");
    expect(result.current).toBe("fine");
  });

  it("tracks pen <-> finger switches mid-session", () => {
    stubAnyPointerCoarse(false);
    const { result } = renderHook(() => usePointerType());

    pointerDown("pen");
    expect(result.current).toBe("fine");
    pointerDown("touch");
    expect(result.current).toBe("coarse");
    pointerDown("touch");
    expect(result.current).toBe("coarse");
    pointerDown("mouse");
    expect(result.current).toBe("fine");
  });

  it("keeps the last kind on empty pointerType", () => {
    stubAnyPointerCoarse(false);
    const { result } = renderHook(() => usePointerType());

    pointerDown("touch");
    expect(result.current).toBe("coarse");
    pointerDown("");
    expect(result.current).toBe("coarse");
    expect(useDawStore.getState().pointerKind).toBe("coarse");
  });

  it("stops tracking after unmount", () => {
    stubAnyPointerCoarse(false);
    const { unmount } = renderHook(() => usePointerType());
    unmount();
    useDawStore.setState({ pointerKind: "fine" });
    pointerDown("touch");
    expect(useDawStore.getState().pointerKind).toBe("fine");
  });
});
