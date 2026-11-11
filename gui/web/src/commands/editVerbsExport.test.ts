import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import {
  EDIT_SELECTIONS,
  editFixtureProject,
  JONAS,
  MIRA,
} from "../test/actionBarFixtures";
import {
  barModelOf,
  currentEditFacts as factsOf,
  runEditVerb,
} from "./editVerbs";
import { clearRegisteredCommands } from "./execute";
import { registerDawCommands } from "./register";

const bounce = vi.hoisted(() => ({
  running: false,
  start: vi.fn(async (): Promise<{ status: "ok" }> => ({ status: "ok" })),
  cancel: vi.fn(async (): Promise<{ status: "ok" }> => ({ status: "ok" })),
}));
vi.mock("./bounceRunnerHandle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bounceRunnerHandle")>()),
  startBounce: bounce.start,
  cancelBounce: bounce.cancel,
  bounceRunning: () => bounce.running,
}));

function host(selection: unknown, extra: Record<string, unknown> = {}) {
  useDawStore.setState({
    project: editFixtureProject(),
    projectPath: "/tmp/episode",
    guestMode: null,
    shareCapabilities: null,
    stage: "edit",
    selection: selection as never,
    soloTracks: {},
    activityJob: null,
    rangeBusy: false,
    joinMutationInFlight: false,
    playheadSec: 1,
    ...extra,
  });
}

const TRACKS = { kind: "track", trackId: MIRA, trackIds: [MIRA, JONAS] };

const itemOf = (selection: unknown, extra: Record<string, unknown> = {}) => {
  host(selection, extra);
  return barModelOf(factsOf()!, useDawStore.getState()).items.find(
    (item) => item.id === "export",
  );
};

beforeEach(() => {
  bounce.running = false;
  bounce.start.mockClear();
  bounce.cancel.mockClear();
  localStorage.clear();
  clearRegisteredCommands();
  registerDawCommands();
});

describe("Export verb", () => {
  const SELECTIONS = [
    ["a range", EDIT_SELECTIONS.rangeOnAllTracks],
    ["tracks", TRACKS],
    ["nothing", null],
  ] as const;

  it.each(SELECTIONS)("is on the bar for %s", (_name, selection) => {
    expect(itemOf(selection)).toEqual({ id: "export" });
  });

  it.each(SELECTIONS)(
    "is absent for an editor guest with %s",
    (_name, selection) => {
      expect(
        itemOf(selection, { projectPath: "share:tok", guestMode: "edit" }),
      ).toBeUndefined();
    },
  );

  it("reads Cancel export and pressed while a bounce runs", () => {
    bounce.running = true;
    expect(itemOf(null)).toEqual({
      id: "export",
      label: "Cancel export",
      pressed: true,
    });
  });

  it("is disabled with a reason while another export runs", () => {
    expect(
      itemOf(null, {
        activityJob: { id: "x", kind: "export", status: "running" },
      }),
    ).toEqual({ id: "export", disabledReason: "Another export is running." });
  });

  it("exports the whole mix with nothing selected", async () => {
    host(null);
    await runEditVerb("export", factsOf()!);
    expect(bounce.start).toHaveBeenCalledWith({
      range: null,
      trackIds: null,
      source: "mix",
      includeMp3: false,
    });
  });

  it("exports the selected tracks at full length, with MP3 when saved", async () => {
    localStorage.setItem(
      "sharecut.exportRange",
      '{"source":"mix","includeMp3":true}',
    );
    host({ kind: "track", trackId: MIRA });
    await runEditVerb("export", factsOf()!);
    expect(bounce.start).toHaveBeenCalledWith({
      range: null,
      trackIds: [MIRA],
      source: "selected",
      includeMp3: true,
    });
  });

  it("exports a range of every audible track", async () => {
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    await runEditVerb("export", factsOf()!);
    expect(bounce.start).toHaveBeenCalledTimes(1);
    const request = bounce.start.mock.calls[0] as unknown as [
      { range: { intervals: unknown; track_ids: string[] }; source: string },
    ];
    expect(request[0].range.intervals).toEqual([{ start: 1, end: 2 }]);
    expect(request[0].range.track_ids).toEqual([MIRA, JONAS]);
    expect(request[0].source).toBe("mix");
  });

  it("cancels instead of starting when a bounce runs", async () => {
    bounce.running = true;
    host(null);
    await runEditVerb("export", factsOf()!);
    expect(bounce.cancel).toHaveBeenCalledOnce();
    expect(bounce.start).not.toHaveBeenCalled();
  });

  it("leaves the options row to the bar", async () => {
    host(null);
    expect(await runEditVerb("export", factsOf()!, "options")).toEqual({
      status: "ok",
    });
    expect(bounce.start).not.toHaveBeenCalled();
  });
});
