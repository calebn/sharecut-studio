import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearClipboard, setClipboard } from "../edit/clipboard";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import {
  CREATE_MENU_COMMANDS,
  createAnnouncement,
  createMenuRowsFor,
  createPickArgs,
  runCreatePick,
} from "./createMenuMapping";

const executePointerCommand = vi.hoisted(() => vi.fn());
vi.mock("../commands/pointer", () => ({ executePointerCommand }));

const lane: { atTime: number; trackId: string | null } = {
  atTime: 12.5,
  trackId: "host",
};
const offLane = { atTime: 12.5, trackId: null };

function session(shareCapabilities: string[] | null = null) {
  useDawStore.setState({
    projectPath: shareCapabilities ? "share:tok" : "/tmp/ep.project.json",
    shareCapabilities,
    guestMode: shareCapabilities ? "edit" : null,
    project: minimalProject({ tracks: [sampleTrack({ id: "host" })] }),
  });
}

const ids = (place: { trackId: string | null }) =>
  createMenuRowsFor(place).map((row) => row.id);

beforeEach(() => {
  executePointerCommand.mockReset();
  executePointerCommand.mockResolvedValue({ status: "ok" });
  clearClipboard();
  session();
  useDawStore.getState().setLayerVisible("showLevels", false);
  useDawStore.setState({ statusAnnouncement: "", feedbackToast: null });
});

describe("createMenuRowsFor", () => {
  it("offers the volume row on any lane, whether or not the envelope is showing", () => {
    expect(ids(lane)).toEqual([
      "split",
      "comment",
      "addChapter",
      "addVolumePoint",
    ]);
    useDawStore.getState().setLayerVisible("showLevels", true);
    expect(ids(lane)).toEqual([
      "split",
      "comment",
      "addChapter",
      "addVolumePoint",
    ]);
  });

  it("leaves the lane's rows out off a lane", () => {
    expect(ids(offLane)).toEqual(["split", "comment", "addChapter"]);
  });

  it("adds Paste last, only while the clipboard holds something", () => {
    setClipboard({
      timelineStart: 0,
      timelineEnd: 5,
      mode: "copy",
      extracts: [],
    });
    expect(ids(lane).at(-1)).toBe("paste");
    clearClipboard();
    expect(ids(lane)).not.toContain("paste");
  });

  it("leaves out a row whose command the session may not run, instead of showing it dead", () => {
    session(["view", "play", "comment", "reply"]);
    expect(ids(lane)).toEqual(["comment"]);
  });

  it("keeps the envelope row for an editor link", () => {
    session(["view", "play", "comment", "reply", "suggest", "edit"]);
    expect(ids(lane)).toContain("addVolumePoint");
  });
});

describe("createPickArgs", () => {
  it("sends the held time, and the held lane where the command wants one", () => {
    expect(createPickArgs("split", lane)).toEqual({ atTime: 12.5 });
    expect(createPickArgs("addChapter", lane)).toEqual({ atTime: 12.5 });
    expect(createPickArgs("paste", lane)).toEqual({ atTime: 12.5 });
    expect(createPickArgs("comment", lane)).toEqual({
      atTime: 12.5,
      trackId: "host",
    });
    expect(createPickArgs("comment", offLane)).toEqual({ atTime: 12.5 });
    expect(createPickArgs("addVolumePoint", lane)).toEqual({
      atTime: 12.5,
      trackId: "host",
    });
  });
});

describe("runCreatePick", () => {
  it.each([
    ["split", "edit.bladeCut", { atTime: 12.5 }],
    ["comment", "comment.draftAt", { atTime: 12.5, trackId: "host" }],
    ["addChapter", "edit.addChapter", { atTime: 12.5 }],
    ["addVolumePoint", "envelope.addPoint", { atTime: 12.5, trackId: "host" }],
    ["paste", "edit.paste", { atTime: 12.5 }],
  ] as const)("runs %s as %s at the held place", async (id, command, args) => {
    await runCreatePick(id, lane);
    expect(executePointerCommand).toHaveBeenCalledOnce();
    expect(executePointerCommand).toHaveBeenCalledWith(command, args);
    expect(CREATE_MENU_COMMANDS[id]).toBe(command);
  });

  it("cuts at the held time with edit.bladeCut, never at the playhead with edit.split", async () => {
    await runCreatePick("split", lane);
    expect(executePointerCommand.mock.calls.map((call) => call[0])).toEqual([
      "edit.bladeCut",
    ]);
  });

  it("turns the volume envelope on before adding a point while it is hidden", async () => {
    let shownWhenRun: boolean | null = null;
    executePointerCommand.mockImplementation(async () => {
      shownWhenRun = useDawStore.getState().layers.showLevels;
      return { status: "ok" };
    });
    await runCreatePick("addVolumePoint", lane);
    expect(shownWhenRun).toBe(true);
    expect(useDawStore.getState().layers.showLevels).toBe(true);
  });

  it("changes no layer for any other row", async () => {
    await runCreatePick("comment", lane);
    await runCreatePick("split", lane);
    expect(useDawStore.getState().layers.showLevels).toBe(false);
  });

  it("tells why a refused command did nothing", async () => {
    executePointerCommand.mockResolvedValue({
      status: "disabled",
      reason: "A point is already there",
    });
    await runCreatePick("addVolumePoint", lane);
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "A point is already there",
    );
    expect(useDawStore.getState().feedbackToast?.tone).toBe("error");
  });

  it("tells a command that threw, and says nothing when it ran", async () => {
    await runCreatePick("split", lane);
    expect(useDawStore.getState().statusAnnouncement).toBe("");
    executePointerCommand.mockRejectedValue(new Error("Server unreachable"));
    await runCreatePick("split", lane);
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Server unreachable",
    );
  });
});

describe("createAnnouncement", () => {
  it("names the time, the lane when there is one, and how many rows", () => {
    expect(createAnnouncement("00:12.500", "Avery", 4)).toBe(
      "Create at 00:12.500 on Avery, 4 actions",
    );
    expect(createAnnouncement("00:12.500", null, 3)).toBe(
      "Create at 00:12.500, 3 actions",
    );
  });
});
