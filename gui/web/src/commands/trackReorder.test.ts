import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { matchKeymapCommands } from "../keymap/registry";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import {
  isTrackReorderDrag,
  reorderInsertIndex,
  setTrackReorderData,
  TRACK_REORDER_MIME,
  TRACK_REORDER_TEXT_MIME,
} from "../tracks/trackReorder";
import { clearRegisteredCommands, execute } from "./execute";
import {
  _resetTrackMutateChainForTests,
  registerDawCommands,
} from "./register";

vi.mock("../api", () => ({
  reorderTrackCommand: vi.fn(async () => undefined),
  refreshProject: vi.fn(async () =>
    minimalProject({
      tracks: [
        {
          id: "b",
          label: "B",
          role: "dialogue",
          speaker: null,
          gain_db: 0,
          muted: false,
          duration_sec: 10,
          fx_count: 0,
          stem_is_fresh: true,
        },
        {
          id: "a",
          label: "A",
          role: "dialogue",
          speaker: null,
          gain_db: 0,
          muted: false,
          duration_sec: 10,
          fx_count: 0,
          stem_is_fresh: true,
        },
        {
          id: "c",
          label: "C",
          role: "dialogue",
          speaker: null,
          gain_db: 0,
          muted: false,
          duration_sec: 10,
          fx_count: 0,
          stem_is_fresh: true,
        },
      ],
    }),
  ),
  removeTrackCommand: vi.fn(),
  deleteClips: vi.fn(),
  rippleDeleteClips: vi.fn(),
  pasteSegment: vi.fn(),
  rippleDeleteRange: vi.fn(),
  duplicateSegment: vi.fn(),
  undoHistory: vi.fn(),
  redoHistory: vi.fn(),
  splitAtTime: vi.fn(),
  startRenderPreview: vi.fn(),
  waitForPipelineJob: vi.fn(),
}));

function threeTracks() {
  return minimalProject({
    tracks: [
      {
        id: "a",
        label: "A",
        role: "dialogue",
        speaker: null,
        gain_db: 0,
        muted: false,
        duration_sec: 10,
        fx_count: 0,
        stem_is_fresh: true,
      },
      {
        id: "b",
        label: "B",
        role: "dialogue",
        speaker: null,
        gain_db: 0,
        muted: false,
        duration_sec: 10,
        fx_count: 0,
        stem_is_fresh: true,
      },
      {
        id: "c",
        label: "C",
        role: "dialogue",
        speaker: null,
        gain_db: 0,
        muted: false,
        duration_sec: 10,
        fx_count: 0,
        stem_is_fresh: true,
      },
    ],
  });
}

describe("track reorder helpers", () => {
  it("computes insert index after removal", () => {
    expect(reorderInsertIndex(3, 1, false)).toBe(1);
    expect(reorderInsertIndex(3, 1, true)).toBe(2);
    expect(reorderInsertIndex(0, 2, true)).toBe(2);
    expect(reorderInsertIndex(0, 2, false)).toBe(1);
  });

  it("detects track-reorder MIME types including text/plain", () => {
    expect(
      isTrackReorderDrag({
        types: [TRACK_REORDER_MIME],
      } as unknown as DataTransfer),
    ).toBe(true);
    expect(
      isTrackReorderDrag({
        types: [TRACK_REORDER_TEXT_MIME],
      } as unknown as DataTransfer),
    ).toBe(true);
    expect(
      isTrackReorderDrag({
        types: ["Files", "text/uri-list"],
      } as unknown as DataTransfer),
    ).toBe(false);
  });

  it("writes text/plain track id for cross-browser drag", () => {
    const store = new Map<string, string>();
    const dt = {
      setData: (type: string, value: string) => {
        store.set(type, value);
      },
      effectAllowed: "none" as DataTransfer["effectAllowed"],
    };
    setTrackReorderData(dt as unknown as DataTransfer, "host");
    expect(store.get(TRACK_REORDER_TEXT_MIME)).toBe("host");
    expect(dt.effectAllowed).toBe("move");
  });
});

describe("track.reorder / moveUp / moveDown", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    _resetTrackMutateChainForTests();
    vi.mocked(api.reorderTrackCommand).mockClear();
    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
      shareCapabilities: null,
      project: threeTracks(),
      selection: { kind: "track", trackId: "b" },
      selectedTrackIds: ["b"],
      commentMode: false,
      timelineFocused: true,
    });
  });

  it("reorders via document command", async () => {
    expect(
      (
        await execute(
          "track.reorder",
          { trackId: "c", index: 0 },
          { skipWhen: true },
        )
      ).status,
    ).toBe("ok");
    expect(api.reorderTrackCommand).toHaveBeenCalledWith("/tmp/ep", "c", 0);
  });

  it("moves inspector track up and down", async () => {
    expect((await execute("track.moveUp")).status).toBe("ok");
    expect(api.reorderTrackCommand).toHaveBeenCalledWith("/tmp/ep", "b", 0);

    vi.mocked(api.reorderTrackCommand).mockClear();
    useDawStore.setState({
      project: threeTracks(),
      selection: { kind: "track", trackId: "b" },
    });
    expect((await execute("track.moveDown")).status).toBe("ok");
    expect(api.reorderTrackCommand).toHaveBeenCalledWith("/tmp/ep", "b", 2);
  });

  it("disables moveUp at top", async () => {
    useDawStore.setState({
      selection: { kind: "track", trackId: "a" },
    });
    expect((await execute("track.moveUp")).status).toBe("disabled");
    expect(api.reorderTrackCommand).not.toHaveBeenCalled();
  });

  it("maps ArrowUp/Down when track inspector selected", () => {
    const up = matchKeymapCommands({
      key: "ArrowUp",
      code: "ArrowUp",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
    expect(up.map((c) => c.id)).toContain("track.moveUp");
    const down = matchKeymapCommands({
      key: "ArrowDown",
      code: "ArrowDown",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
    expect(down.map((c) => c.id)).toContain("track.moveDown");
  });

  it("serializes rapid moveUp so the second command re-reads order", async () => {
    let release!: () => void;
    const held = new Promise<Record<string, unknown>>((resolve) => {
      release = () => {
        resolve({});
      };
    });
    vi.mocked(api.reorderTrackCommand).mockImplementation(async () => held);
    const first = execute("track.moveUp");
    const second = execute("track.moveUp");
    release();
    const results = await Promise.all([first, second]);
    expect(results[0]?.status).toBe("ok");
    expect(results[1]?.status).toBe("disabled");
    expect(api.reorderTrackCommand).toHaveBeenCalledTimes(1);
    expect(api.reorderTrackCommand).toHaveBeenCalledWith("/tmp/ep", "b", 0);
  });

  it("moves lanes before the command resolves and does not refresh", async () => {
    let release!: () => void;
    const held = new Promise<Record<string, unknown>>((resolve) => {
      release = () => {
        resolve({});
      };
    });
    vi.mocked(api.reorderTrackCommand).mockImplementation(async () => held);
    const pending = execute(
      "track.reorder",
      { trackId: "c", index: 0 },
      { skipWhen: true },
    );
    await Promise.resolve();
    expect(useDawStore.getState().project?.tracks.map((t) => t.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(api.refreshProject).not.toHaveBeenCalled();
    release();
    expect((await pending).status).toBe("ok");
  });

  it("reverts track order when reorder fails", async () => {
    vi.mocked(api.reorderTrackCommand).mockRejectedValueOnce(
      new Error("network"),
    );
    const r = await execute(
      "track.reorder",
      { trackId: "c", index: 0 },
      { skipWhen: true },
    );
    expect(r.status).toBe("disabled");
    expect(useDawStore.getState().project?.tracks.map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(useDawStore.getState().statusAnnouncement).toMatch(/network/);
  });
});
