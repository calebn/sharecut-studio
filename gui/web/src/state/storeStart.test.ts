import { afterEach, describe, expect, it, vi } from "vitest";
import { PHONE_MQ, TABLET_MQ } from "../hooks/useViewportClass";

function stubScreen({
  phone,
  tablet,
  primaryFine,
  anyCoarse,
}: {
  phone: boolean;
  tablet: boolean;
  primaryFine: boolean;
  anyCoarse: boolean;
}) {
  const answers: Record<string, boolean> = {
    [PHONE_MQ]: phone,
    [TABLET_MQ]: tablet,
    "(pointer: fine)": primaryFine,
    "(any-pointer: coarse)": anyCoarse,
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: answers[query] ?? false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

/** The store is made when its module loads, so each case loads a new copy. */
async function freshStore() {
  vi.resetModules();
  return import("./dawStore");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the store's starting shell and pointer kind", () => {
  it("start from the screen's own, so the first render has nothing to correct", async () => {
    stubScreen({
      phone: true,
      tablet: true,
      primaryFine: false,
      anyCoarse: true,
    });
    const { useDawStore, estimateTimelineViewportWidth } = await freshStore();
    const state = useDawStore.getState();
    expect(state.shellBreakpoint).toBe("phone");
    expect(state.pointerKind).toBe("coarse");
    expect(state.timelineViewportWidth).toBe(
      estimateTimelineViewportWidth("phone"),
    );
  });

  it("stay desktop and fine on a desktop screen", async () => {
    stubScreen({
      phone: false,
      tablet: false,
      primaryFine: true,
      anyCoarse: false,
    });
    const { useDawStore } = await freshStore();
    expect(useDawStore.getState().shellBreakpoint).toBe("desktop");
    expect(useDawStore.getState().pointerKind).toBe("fine");
  });

  it("stay desktop and fine where the page cannot ask the screen", async () => {
    vi.stubGlobal("matchMedia", undefined);
    const { useDawStore } = await freshStore();
    expect(useDawStore.getState().shellBreakpoint).toBe("desktop");
    expect(useDawStore.getState().pointerKind).toBe("fine");
  });
});
