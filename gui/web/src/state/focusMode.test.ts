import { describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import { useDawStore } from "./dawStore";

describe("focusMode store", () => {
  it("cycles focus modes and sets text tab", () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.getState().setFocusMode("default");
    useDawStore.getState().cycleFocusMode();
    expect(useDawStore.getState().focusMode).toBe("timeline");
    useDawStore.getState().cycleFocusMode();
    expect(useDawStore.getState().focusMode).toBe("text");
    expect(useDawStore.getState().activeTab).toBe("transcript");
    useDawStore.getState().cycleFocusMode();
    expect(useDawStore.getState().focusMode).toBe("review");
    expect(useDawStore.getState().activeTab).toBe("comments");
  });

  it("sets mobile mode and more destination", () => {
    useDawStore.getState().setMobileMode("more");
    useDawStore.getState().setMoreDestination("impact");
    expect(useDawStore.getState().mobileMode).toBe("more");
    expect(useDawStore.getState().moreDestination).toBe("impact");
    expect(useDawStore.getState().activeTab).toBe("impact");
  });
});
