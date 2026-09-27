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

  it("opening a tab the layout does not show restores the default layout", () => {
    const st = () => useDawStore.getState();
    st().hydrate("/tmp/p.json", minimalProject());
    st().setLayoutMode("timeline");
    st().setActiveTab("history");
    expect(st().layoutMode).toBe("default");
    expect(st().activeTab).toBe("history");
    st().setLayoutMode("text");
    st().setActiveTab("transcript");
    expect(st().layoutMode).toBe("text");
    st().setActiveTab("impact");
    expect(st().layoutMode).toBe("default");
    expect(st().activeTab).toBe("impact");
    st().setLayoutMode("review");
    st().setActiveTab("comments");
    expect(st().layoutMode).toBe("review");
    st().setActiveTab("pipeline");
    expect(st().layoutMode).toBe("default");
    expect(st().activeTab).toBe("pipeline");
  });

  it("leaving the timeline layout for a tab clears timeline focus", () => {
    const st = () => useDawStore.getState();
    st().hydrate("/tmp/p.json", minimalProject());
    st().setLayoutMode("timeline");
    expect(st().timelineFocused).toBe(true);
    st().setActiveTab("history");
    expect(st().timelineFocused).toBe(false);
    expect(st().layoutMode).toBe("default");
  });

  it("entering comment mode restores a layout that hides Comments", () => {
    const st = () => useDawStore.getState();
    st().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({ commentMode: false });
    st().setLayoutMode("text");
    st().toggleCommentMode();
    expect(st().activeTab).toBe("comments");
    expect(st().layoutMode).toBe("default");
    st().toggleCommentMode();
    st().setLayoutMode("review");
    st().toggleCommentMode();
    expect(st().layoutMode).toBe("review");
    st().toggleCommentMode();
    st().setLayoutMode("default");
  });

  it("entering the phone shell resets the layout", () => {
    const st = () => useDawStore.getState();
    st().setShellBreakpoint("desktop");
    st().setLayoutMode("timeline");
    st().setShellBreakpoint("phone");
    expect(st().layoutMode).toBe("default");
    st().setShellBreakpoint("desktop");
    expect(st().layoutMode).toBe("default");
  });

  it("sets mobile mode and more destination", () => {
    useDawStore.getState().setMobileMode("more");
    useDawStore.getState().setMoreDestination("impact");
    expect(useDawStore.getState().mobileMode).toBe("more");
    expect(useDawStore.getState().moreDestination).toBe("impact");
    expect(useDawStore.getState().activeTab).toBe("impact");
  });
});
