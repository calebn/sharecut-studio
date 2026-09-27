import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

describe("lane height commands", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({
      timelineFocused: true,
      laneHeightMode: "fixed",
      laneHeightPx: 104,
      drawnLaneHeightPx: null,
    });
  });

  afterEach(() => {
    clearRegisteredCommands();
    useDawStore.setState({
      laneHeightMode: "fixed",
      laneHeightPx: 104,
      drawnLaneHeightPx: null,
    });
  });

  it("toggles the fit mode and announces it", async () => {
    expect((await execute("view.fitTracksHeight")).status).toBe("ok");
    expect(useDawStore.getState().laneHeightMode).toBe("fit");
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Tracks fit window height",
    );

    expect((await execute("view.fitTracksHeight")).status).toBe("ok");
    expect(useDawStore.getState().laneHeightMode).toBe("fixed");
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Fixed track height",
    );
  });

  it("steps the fixed height up through the list", async () => {
    await execute("view.trackHeightIncrease");
    expect(useDawStore.getState().laneHeightPx).toBe(144);
    await execute("view.trackHeightIncrease");
    expect(useDawStore.getState().laneHeightPx).toBe(192);
    await execute("view.trackHeightIncrease");
    expect(useDawStore.getState().laneHeightPx).toBe(240);
    await execute("view.trackHeightIncrease");
    expect(useDawStore.getState().laneHeightPx).toBe(240);
  });

  it("stepping down from fit switches to fixed at the floor", async () => {
    useDawStore.getState().setLaneHeightMode("fit");
    useDawStore.setState({ laneHeightPx: 72 });
    await execute("view.trackHeightDecrease");
    expect(useDawStore.getState().laneHeightMode).toBe("fixed");
    expect(useDawStore.getState().laneHeightPx).toBe(72);
  });

  it("Increase from fit never shrinks the drawn lanes", async () => {
    useDawStore.setState({
      laneHeightMode: "fit",
      laneHeightPx: 104,
      drawnLaneHeightPx: 240,
    });
    await execute("view.trackHeightIncrease");
    expect(useDawStore.getState().laneHeightMode).toBe("fixed");
    expect(useDawStore.getState().laneHeightPx).toBe(240);
  });

  it("steps from an off-list fitted height", async () => {
    useDawStore.setState({
      laneHeightMode: "fit",
      laneHeightPx: 104,
      drawnLaneHeightPx: 187,
    });
    await execute("view.trackHeightIncrease");
    expect(useDawStore.getState().laneHeightPx).toBe(192);
    useDawStore.setState({ laneHeightMode: "fit", drawnLaneHeightPx: 187 });
    await execute("view.trackHeightDecrease");
    expect(useDawStore.getState().laneHeightPx).toBe(144);
  });

  it("Decrease from a fitted 72px never grows back to the saved height", async () => {
    useDawStore.setState({
      laneHeightMode: "fit",
      laneHeightPx: 192,
      drawnLaneHeightPx: 72,
    });
    await execute("view.trackHeightDecrease");
    expect(useDawStore.getState().laneHeightPx).toBe(72);
  });

  it("fixed mode steps the saved px, not the drawn px", async () => {
    useDawStore.setState({
      laneHeightMode: "fixed",
      laneHeightPx: 104,
      drawnLaneHeightPx: 240,
    });
    await execute("view.trackHeightIncrease");
    expect(useDawStore.getState().laneHeightPx).toBe(144);
  });

  it("is disabled when the timeline is not focused", async () => {
    useDawStore.setState({ timelineFocused: false });
    expect((await execute("view.trackHeightIncrease")).status).toBe("disabled");
    expect(
      (await execute("view.trackHeightIncrease", {}, { skipWhen: true }))
        .status,
    ).toBe("ok");
  });
});
