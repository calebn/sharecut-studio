import { beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../../commands/catalog";
import {
  buildCommandContext,
  evaluateWhen,
  gateNeverRuns,
} from "../../commands/context";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { paletteCommands } from "./commandPaletteRows";
import hostRows from "./hostPaletteRows.json";

const ROLES = {
  host: { projectPath: "/tmp/ep", guestMode: null, caps: null },
  editor: {
    projectPath: "share:tok",
    guestMode: "edit",
    caps: ["view", "play", "comment", "edit", "suggest", "action", "reply"],
  },
  commenter: {
    projectPath: "share:tok",
    guestMode: "comment",
    caps: ["view", "play", "comment", "suggest", "action", "reply"],
  },
  viewer: {
    projectPath: "share:tok",
    guestMode: "view",
    caps: ["view", "play"],
  },
} as const;

function rows(role: keyof typeof ROLES, stage: "edit" | "review") {
  useDawStore.setState({
    projectPath: ROLES[role].projectPath,
    guestMode: ROLES[role].guestMode,
    shareCapabilities: ROLES[role].caps ? [...ROLES[role].caps] : null,
    project: minimalProject({ tracks: [sampleTrack()] }),
    stage,
    selection: null,
    shellBreakpoint: "desktop",
  } as never);
  return paletteCommands(buildCommandContext()).map(
    (r) => [r.id, r.disabledReason] as const,
  );
}

const HOST_ONLY_AND_RECORD = [
  "edit.addChapter",
  "export.bounce",
  "export.deliverables",
  "export.transcript",
  "help.diagnosticsBundle",
  "mcp.connect",
  "models.open",
  "project.home",
  "project.new",
  "project.open",
  "range.bounce",
  "record.copyGuestLink",
  "record.createRoom",
  "record.land",
  "record.marker",
  "record.pause",
  "record.resume",
  "record.roomTone",
  "record.setTarget",
  "record.start",
  "record.stop",
  "room.mute",
  "room.pause",
  "room.stop",
  "room.take",
  "settings.open",
  "share.manage",
  "stage.prepare",
  "stage.record",
  "track.splitSpeakers",
  "transcript.adjustTiming",
];

const VIEWER_ROWS = [
  ["transport.togglePlay", null],
  ["transport.stop", null],
  ["transport.shuttleBack", null],
  ["transport.shuttleForward", null],
  ["stage.review", null],
  ["stage.handoff", null],
  ["navigation.nudgePlayheadBack", null],
  ["navigation.nudgePlayheadForward", null],
  ["navigation.goToStart", null],
  ["navigation.goToEnd", null],
  ["edit.clearSelection", "Nothing selected"],
  ["edit.nextOccurrence", "No other matches to jump to"],
  ["range.play", "Choose a range"],
  ["range.arm", "Nothing to select yet"],
  ["help.guides", null],
  ["presence.unfollow", "Not following"],
];

const COMMENTER_ROWS = [
  ["transport.togglePlay", null],
  ["transport.stop", null],
  ["transport.shuttleBack", null],
  ["transport.shuttleForward", null],
  ["stage.review", null],
  ["stage.handoff", null],
  ["navigation.nudgePlayheadBack", null],
  ["navigation.nudgePlayheadForward", null],
  ["navigation.goToStart", null],
  ["navigation.goToEnd", null],
  ["edit.clearSelection", "Nothing selected"],
  ["edit.nextOccurrence", "No other matches to jump to"],
  ["range.play", "Choose a range"],
  ["range.cut", "Choose a range"],
  ["range.mute", "Choose a range"],
  ["range.comment", "Choose a range"],
  ["range.arm", "Nothing to select yet"],
  ["comment.draftAt", null],
  ["help.guides", null],
  ["presence.unfollow", "Not following"],
];

describe("a guest link's palette", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
  });

  it("lists a Viewer only what it can use, with a reason on the two that need a range", () => {
    expect(rows("viewer", "review")).toEqual(VIEWER_ROWS);
  });

  it("lists a Commenter the Viewer's rows plus Add comment, with the range rows greyed until a range is chosen", () => {
    expect(rows("commenter", "review")).toEqual(COMMENTER_ROWS);
  });

  it("leaves the host-only, record and stage rows out of an Editor link on Review and on Edit", () => {
    const hostIds = hostRows.flatMap(([id]) => (id === null ? [] : [id]));
    for (const stage of ["review", "edit"] as const) {
      const ids = rows("editor", stage).map(([id]) => id);
      expect(hostIds.filter((id) => !ids.includes(id)).sort()).toEqual(
        HOST_ONLY_AND_RECORD,
      );
    }
  });

  it("greys an Editor's range rows with the reason the press would give", () => {
    const editor = new Map(rows("editor", "edit"));
    for (const id of [
      "range.play",
      "range.cut",
      "range.mute",
      "range.fillRoomTone",
      "range.comment",
    ]) {
      expect(editor.get(id)).toBe("Choose a range");
    }
    expect(editor.get("range.arm")).toBe("Nothing to select yet");
  });

  it("keeps an Editor on Review able to open Edit, with the Edit-only rows greyed, not removed", () => {
    const editor = new Map(rows("editor", "review"));
    expect(editor.get("stage.edit")).toBeNull();
    expect(editor.get("edit.bladeCut")).toBe(
      "Open Edit to change the timeline",
    );
    expect(editor.get("view.zoomIn")).toBeNull();
    expect(editor.has("range.bounce")).toBe(false);
  });

  it("gives the host exactly the rows and reasons it had before guests were filtered", () => {
    expect(rows("host", "edit")).toEqual(hostRows);
  });

  it("keeps every row while the role's project has not loaded", () => {
    useDawStore.setState({
      projectPath: "share:tok",
      guestMode: "view",
      shareCapabilities: null,
      project: null,
      stage: "review",
    } as never);
    const ctx = buildCommandContext();
    expect(gateNeverRuns("canManageProjects", ctx)).toBe(false);
    expect(gateNeverRuns("canComment", ctx)).toBe(false);
  });

  it("answers the keyboard silently for a lane key on a link with no timeline", () => {
    rows("viewer", "review");
    expect(
      evaluateWhen(COMMANDS["edit.mute"].when, buildCommandContext()),
    ).toEqual({
      ok: false,
      reason: "This link has no timeline",
    });
    rows("editor", "review");
    expect(
      evaluateWhen(COMMANDS["edit.mute"].when, buildCommandContext()),
    ).toEqual({
      ok: true,
    });
  });
});
