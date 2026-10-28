import { beforeEach, describe, expect, it } from "vitest";
import { shareProjectKey } from "../shareMode";
import { minimalProject } from "../test/fixtures";
import { readLastStage } from "../utils/stagePref";
import { useDawStore } from "./dawStore";

const st = () => useDawStore.getState();

describe("stageSlice", () => {
  beforeEach(() => {
    localStorage.clear();
    st().hydrate("/tmp/stage-a.json", minimalProject());
    useDawStore.setState({
      stage: "edit",
      stageViews: {},
      openSheet: null,
      zoomPxPerSec: 40,
      scrollLeft: 0,
      userZoomed: false,
      landingSettled: false,
    });
  });

  it("starts on Edit with nothing saved", () => {
    expect(st().stage).toBe("edit");
    expect(st().stageViews).toEqual({});
    expect(st().openSheet).toBeNull();
  });

  it("restores the zoom, scroll and userZoomed a stage left", () => {
    useDawStore.setState({
      zoomPxPerSec: 80,
      scrollLeft: 300,
      userZoomed: true,
    });
    st().openStage("review");
    expect(st().stageViews.edit).toMatchObject({
      zoomPxPerSec: 80,
      scrollLeft: 300,
      userZoomed: true,
    });
    // Review has no view yet: it starts at the left, fitted.
    expect(st().scrollLeft).toBe(0);
    expect(st().userZoomed).toBe(false);

    useDawStore.setState({ zoomPxPerSec: 12, scrollLeft: 5, userZoomed: true });
    st().openStage("edit");
    expect(st().zoomPxPerSec).toBe(80);
    expect(st().scrollLeft).toBe(300);
    expect(st().userZoomed).toBe(true);
    expect(st().stageViews.review).toMatchObject({ zoomPxPerSec: 12 });

    st().openStage("review");
    expect(st().zoomPxPerSec).toBe(12);
    expect(st().scrollLeft).toBe(5);
  });

  it("writes the snapshot and the new stage in one store update", () => {
    let writes = 0;
    const off = useDawStore.subscribe(() => {
      writes += 1;
    });
    useDawStore.setState({ zoomPxPerSec: 64, userZoomed: true });
    writes = 0;
    st().openStage("deliver");
    off();
    expect(writes).toBe(1);
  });

  it("is not overwritten when the timeline unmounts after the switch", () => {
    useDawStore.setState({
      zoomPxPerSec: 90,
      scrollLeft: 40,
      userZoomed: true,
    });
    st().openStage("review");
    // An unmounting TimelineView resets the live values; the snapshot is already taken.
    useDawStore.setState({
      zoomPxPerSec: 10,
      scrollLeft: 0,
      userZoomed: false,
    });
    st().openStage("edit");
    expect(st().zoomPxPerSec).toBe(90);
    expect(st().scrollLeft).toBe(40);
  });

  it("keeps pane scroll offsets across a snapshot", () => {
    st().setPanelScroll("edit", "script", 120);
    useDawStore.setState({ zoomPxPerSec: 55 });
    st().openStage("prepare");
    expect(st().stageViews.edit?.panelScroll).toEqual({ script: 120 });
    expect(st().stageViews.edit?.zoomPxPerSec).toBe(55);
  });

  it("leaves playhead, selection and history position alone", () => {
    useDawStore.setState({
      playheadSec: 12.5,
      isPlaying: true,
      selection: { kind: "track", trackId: "t1" } as never,
      lastAppliedRevision: 7,
    });
    const before = {
      playheadSec: st().playheadSec,
      isPlaying: st().isPlaying,
      selection: st().selection,
      lastAppliedRevision: st().lastAppliedRevision,
    };
    st().openStage("review");
    st().openStage("deliver");
    st().openStage("edit");
    expect({
      playheadSec: st().playheadSec,
      isPlaying: st().isPlaying,
      selection: st().selection,
      lastAppliedRevision: st().lastAppliedRevision,
    }).toEqual(before);
  });

  it("closes sheets on a switch", () => {
    useDawStore.setState({ openSheet: "view", sheetExpanded: true });
    st().openStage("review");
    expect(st().openSheet).toBeNull();
    expect(st().sheetExpanded).toBe(false);

    st().openStage("review", { sheet: "history" });
    expect(st().openSheet).toBe("history");
  });

  it("routes keys to the timeline only on Edit", () => {
    st().openStage("review");
    expect(st().timelineFocused).toBe(false);
    st().openStage("edit");
    expect(st().timelineFocused).toBe(true);
  });

  it("sets the review section with a deep link", () => {
    expect(st().reviewSection).toBe("queue");
    st().openStage("review", { section: "comments" });
    expect(st().stage).toBe("review");
    expect(st().reviewSection).toBe("comments");
    st().openStage("review", { section: "tighten" });
    expect(st().reviewSection).toBe("tighten");
  });

  it("applies a section or sheet to the current stage without a snapshot", () => {
    st().openStage("edit", { sheet: "history" });
    expect(st().openSheet).toBe("history");
    expect(st().stageViews).toEqual({});
  });

  it("remembers the last stage per project, and a user switch settles landing", () => {
    expect(st().landingSettled).toBe(false);
    st().openStage("deliver");
    expect(readLastStage("/tmp/stage-a.json")).toBe("deliver");
    expect(readLastStage("/tmp/other.json")).toBeNull();
    expect(st().landingSettled).toBe(true);
  });

  it("never writes a guest's share token into localStorage", () => {
    useDawStore.setState({ projectPath: shareProjectKey("SECRETTOKEN") });
    st().openStage("review");
    expect(readLastStage(shareProjectKey("SECRETTOKEN"))).toBeNull();
    expect(
      Object.keys(localStorage).filter((k) => k.includes("SECRETTOKEN")),
    ).toEqual([]);
    useDawStore.setState({
      projectPath: "/tmp/stage-a.json",
      guestMode: "view",
    });
    st().openStage("edit");
    expect(Object.keys(localStorage)).toEqual([]);
  });

  it.each([
    ["view", "review"],
    ["comment", "review"],
    ["edit", "edit"],
    [null, "edit"],
  ] as const)("seeds a %s link's first stage as %s", (mode, stage) => {
    st().hydrate("share:abc", minimalProject(), mode);
    expect(st().stage).toBe(stage);
  });

  it("clears stage state on a project switch but not on a refresh", () => {
    st().openStage("review");
    st().hydrate("/tmp/stage-a.json", minimalProject());
    expect(st().stage).toBe("review");
    expect(st().stageViews.edit).toBeDefined();

    st().hydrate("/tmp/stage-b.json", minimalProject());
    expect(st().stage).toBe("edit");
    expect(st().stageViews).toEqual({});
    expect(st().openSheet).toBeNull();
    expect(st().landingSettled).toBe(false);
  });

  it("persists the Script flags", () => {
    st().setScriptCollapsed(true);
    st().setScriptFocus(true);
    expect(localStorage.getItem("sharecut.scriptCollapsed")).toBe("1");
    expect(localStorage.getItem("sharecut.scriptFocus")).toBe("1");
    st().setScriptCollapsed(false);
    expect(localStorage.getItem("sharecut.scriptCollapsed")).toBeNull();
  });
});
