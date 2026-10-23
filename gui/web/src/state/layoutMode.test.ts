import { describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import { useDawStore } from "./dawStore";

describe("layoutMode store", () => {
  it.each(["transcript", "history"] as const)(
    "an explicit request for %s leaves adaptive layout and reveals the panel",
    (tab) => {
      useDawStore.setState({ layoutMode: "adaptive", activeTab: "transcript" });
      useDawStore.getState().setActiveTab(tab);
      expect(useDawStore.getState().layoutMode).toBe("default");
      expect(useDawStore.getState().activeTab).toBe(tab);
    },
  );

  it("resets adaptive intent on phone entry and does not restore it", () => {
    useDawStore.setState({ layoutMode: "adaptive", shellBreakpoint: "tablet" });
    useDawStore.getState().setShellBreakpoint("phone");
    useDawStore.getState().setShellBreakpoint("tablet");
    expect(useDawStore.getState().layoutMode).toBe("default");
  });

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

  describe("arriving on the phone shell with a selection (#1767)", () => {
    const st = () => useDawStore.getState();
    const arrive = (setup: () => void) => {
      st().setShellBreakpoint("tablet");
      st().setMobileMode("listen");
      st().setSelection(null);
      setup();
      st().setShellBreakpoint("phone");
    };

    it("opens on Timeline so the selection is visible", () => {
      arrive(() => st().setSelection({ kind: "track", trackId: "host" }));
      expect(st().mobileMode).toBe("timeline");
    });

    it("opens a transcript selection on Text", () => {
      arrive(() =>
        st().setSelection({
          kind: "transcriptRange",
          trackId: "host",
          startWordIndex: 1,
          endWordIndex: 2,
        }),
      );
      expect(st().mobileMode).toBe("text");
    });

    it("stays on Listen with nothing selected", () => {
      arrive(() => {});
      expect(st().mobileMode).toBe("listen");
    });

    it("keeps a screen the person chose", () => {
      arrive(() => {
        st().setSelection({ kind: "track", trackId: "host" });
        st().setMobileMode("more");
      });
      expect(st().mobileMode).toBe("more");
    });

    it("keeps Listen for the comment composer", () => {
      arrive(() => {
        st().setSelection({ kind: "track", trackId: "host" });
        st().setCommentMode(true);
      });
      expect(st().mobileMode).toBe("listen");
      st().setCommentMode(false);
    });

    it("leaves a phone-to-phone update alone", () => {
      st().setShellBreakpoint("phone");
      st().setMobileMode("listen");
      st().setSelection({ kind: "track", trackId: "host" });
      st().setShellBreakpoint("phone");
      expect(st().mobileMode).toBe("listen");
    });
  });

  it("sets mobile mode and more destination", () => {
    useDawStore.getState().setMobileMode("more");
    useDawStore.getState().setMoreDestination("impact");
    expect(useDawStore.getState().mobileMode).toBe("more");
    expect(useDawStore.getState().moreDestination).toBe("impact");
    expect(useDawStore.getState().activeTab).toBe("impact");
  });

  it("a commenting share guest opens on Comments with the drawer showing, even from a collapsed browser", () => {
    const st = () => useDawStore.getState();
    st().hydrate("/tmp/p.json", minimalProject());
    st().setLayoutMode("timeline");
    st().hydrate("share:abc", minimalProject(), "commenter", ["comment"]);
    expect(st().activeTab).toBe("comments");
    expect(st().layoutMode).toBe("default");
  });
});
