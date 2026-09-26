import { describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import { useDawStore } from "./dawStore";

describe("layoutMode store", () => {
  it("sets the tab and focus for each layout", () => {
    const st = () => useDawStore.getState();
    st().hydrate("/tmp/p.json", minimalProject());
    st().setLayoutMode("text");
    expect(st().activeTab).toBe("transcript");
    expect(st().timelineFocused).toBe(false);
    st().setLayoutMode("review");
    expect(st().activeTab).toBe("comments");
    st().setLayoutMode("timeline");
    expect(st().timelineFocused).toBe(true);
    st().setActiveTab("impact");
    st().setLayoutMode("default");
    expect(st().layoutMode).toBe("default");
    expect(st().activeTab).toBe("impact");
  });

  it("sets mobile mode and more destination", () => {
    useDawStore.getState().setMobileMode("more");
    useDawStore.getState().setMoreDestination("impact");
    expect(useDawStore.getState().mobileMode).toBe("more");
    expect(useDawStore.getState().moreDestination).toBe("impact");
    expect(useDawStore.getState().activeTab).toBe("impact");
  });
});
