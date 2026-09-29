import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { encodePcmWav } from "../src/audio/wavHeader";
import { hostWithResponse } from "./hostRequestFakes";
import {
  clickHostTransport,
  createRecordRoom,
  currentTake,
  ensureHostRecordCommand,
  expectRemintRefused,
  type HostRecordSnapshot,
  hostRecordConnected,
  LandingPendingError,
  landedTrackPeak,
  landedTrackPeakOrPending,
  markSharecutE2e,
  openRecordLink,
  recordLinkPath,
} from "./recordRoom";
import { tempWorkspace } from "./testWorkspace";

const room = {
  session_id: "sess-1",
  guest: { token: "guest-token" },
  producer: { token: "producer-token" },
};

describe("createRecordRoom", () => {
  it("posts the project path and returns the room", async () => {
    const { page, post } = hostWithResponse(true, { room });
    await expect(createRecordRoom(page as never, "/p/x.json")).resolves.toEqual(
      room,
    );
    expect(post).toHaveBeenCalledWith("/api/shares/record", {
      data: { path: "/p/x.json" },
    });
  });

  it("fails with the server body when the share is rejected", async () => {
    const { page } = hostWithResponse(false, { detail: "no project" });
    await expect(createRecordRoom(page as never, "/p/x.json")).rejects.toThrow(
      /no project/,
    );
  });
});

describe("record links", () => {
  it("builds an E2E-enabled record link and navigates to it", async () => {
    expect(recordLinkPath("a b")).toBe("/rec/a%20b?e2e=1");
    const goto = vi.fn(async () => null);
    await openRecordLink({ goto } as never, "guest-token");
    expect(goto).toHaveBeenCalledWith("/rec/guest-token?e2e=1");
  });
});

/**
 * A host fake whose `/api/record/state` GETs return successive entries of
 * `states` (sticking on the last one), and whose `/api/record/command` POST
 * resolves with `post`. A string entry is a minimal snapshot in that state; an
 * object entry is returned as the whole snapshot.
 */
function hostWithRecordStates(
  states: Array<string | HostRecordSnapshot>,
  post: { ok: boolean; body?: unknown } = { ok: true },
) {
  let call = 0;
  const get = vi.fn(async () => {
    const entry = states[Math.min(call, states.length - 1)];
    call += 1;
    const snapshot: HostRecordSnapshot =
      typeof entry === "string"
        ? {
            state: entry,
            session_id: "s",
            take_index: 0,
            recording_ms: 0,
            participants: [],
          }
        : entry;
    return {
      ok: () => true,
      text: async () => JSON.stringify(snapshot),
      json: async () => snapshot,
    };
  });
  const postFn = vi.fn(async () => ({
    ok: () => post.ok,
    text: async () => JSON.stringify(post.body ?? {}),
    json: async () => post.body ?? {},
  }));
  return { page: { request: { get, post: postFn } }, get, post: postFn };
}

describe("ensureHostRecordCommand", () => {
  it("returns without posting when already in state", async () => {
    const { page, post } = hostWithRecordStates(["recording"], { ok: true });
    await ensureHostRecordCommand(
      page as never,
      "/p/x.json",
      "Start",
      "recording",
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("posts the command then polls until the state arrives", async () => {
    const { page, post } = hostWithRecordStates(
      ["stopped", "stopped", "recording"],
      { ok: true },
    );
    await ensureHostRecordCommand(
      page as never,
      "/p/x.json",
      "Start",
      "recording",
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/record/command", {
      data: { path: "/p/x.json", command_type: "Start", payload: {} },
    });
  });

  it("tolerates a rejected POST when the state was reached by a race", async () => {
    const { page, post } = hostWithRecordStates(["stopped", "recording"], {
      ok: false,
      body: { detail: "busy" },
    });
    await ensureHostRecordCommand(
      page as never,
      "/p/x.json",
      "Start",
      "recording",
    );
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("rejects with the server body when the POST fails and state never arrives", async () => {
    const { page } = hostWithRecordStates(["stopped", "stopped"], {
      ok: false,
      body: { detail: "busy" },
    });
    await expect(
      ensureHostRecordCommand(page as never, "/p/x.json", "Start", "recording"),
    ).rejects.toThrow(/busy/);
  });
});

describe("clickHostTransport", () => {
  function listenerHost(page: object) {
    let handler: ((req: unknown) => void) | undefined;
    const on = vi.fn((_event: string, fn: (req: unknown) => void) => {
      handler = fn;
    });
    const off = vi.fn();
    const firePost = () =>
      handler?.({
        method: () => "POST",
        url: () => "http://localhost/api/record/command",
      });
    return { host: { ...page, on, off }, on, off, firePost };
  }

  it("returns without requiring a POST when the click reaches the state", async () => {
    const { page, post } = hostWithRecordStates(["recording"], { ok: true });
    const { host, on, off } = listenerHost(page);
    const button = { click: vi.fn(async () => {}) };
    await clickHostTransport(
      host as never,
      button as never,
      "/p/x.json",
      "Start",
      "recording",
    );
    expect(button.click).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    expect(off).toHaveBeenCalledWith("request", on.mock.calls[0][1]);
  });

  it("confirms the UI POST and then waits for the state", async () => {
    const { page, post } = hostWithRecordStates(["stopped", "recording"], {
      ok: true,
    });
    const { host, on, off, firePost } = listenerHost(page);
    const button = { click: vi.fn(async () => firePost()) };
    await clickHostTransport(
      host as never,
      button as never,
      "/p/x.json",
      "Start",
      "recording",
    );
    expect(post).not.toHaveBeenCalled();
    expect(off).toHaveBeenCalledWith("request", on.mock.calls[0][1]);
  });

  it("rejects and detaches the listener when the UI never POSTs the command", async () => {
    const { page } = hostWithRecordStates(["stopped", "stopped"], {
      ok: true,
    });
    const { host, on, off } = listenerHost(page);
    const button = { click: vi.fn(async () => {}) };
    await expect(
      clickHostTransport(
        host as never,
        button as never,
        "/p/x.json",
        "Start",
        "recording",
        { postTimeout: 50 },
      ),
    ).rejects.toThrow(/did not POST \/api\/record\/command/);
    expect(off).toHaveBeenCalledWith("request", on.mock.calls[0][1]);
  });
});

describe("markSharecutE2e", () => {
  it("sets the E2E window flag before page scripts run", async () => {
    const addInitScript = vi.fn(async (script: () => void) => script());
    const target = window as unknown as { __SHARECUT_E2E?: boolean };
    delete target.__SHARECUT_E2E;
    await markSharecutE2e({ addInitScript } as never);
    expect(target.__SHARECUT_E2E).toBe(true);
    delete target.__SHARECUT_E2E;
  });
});

function writeProject(
  dir: string,
  overrides: {
    tracks?: Array<{ id: string; label?: string }>;
    clips?: Array<{
      track_id: string;
      source_id: string | null;
      timeline_start: number;
      source_start: number;
      source_end: number;
    }>;
    sources?: Array<{ id: string; path: string }>;
  } = {},
): string {
  const projectPath = path.join(dir, "episode.project.json");
  const project = {
    sources: overrides.sources ?? [
      { id: "s1", path: "raw/a.wav" },
      { id: "s2", path: "raw/b.wav" },
    ],
    timeline: {
      tracks: overrides.tracks ?? [{ id: "t1", label: "Ava" }],
      clips: overrides.clips ?? [
        {
          track_id: "t1",
          source_id: "s1",
          timeline_start: 0,
          source_start: 0,
          source_end: 1,
        },
        {
          track_id: "t1",
          source_id: "s2",
          timeline_start: 1,
          source_start: 0,
          source_end: 1,
        },
      ],
    },
  };
  fs.writeFileSync(projectPath, JSON.stringify(project));
  return projectPath;
}

function writeRawWavs(dir: string): void {
  fs.mkdirSync(path.join(dir, "raw"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "raw", "a.wav"),
    encodePcmWav(Int16Array.of(0, 8192, -16384)),
  );
  fs.writeFileSync(
    path.join(dir, "raw", "b.wav"),
    encodePcmWav(Int16Array.of(0, 0, 0)),
  );
}

describe("landedTrackPeak", () => {
  it("resolves the peak across every landed source on the track", async () => {
    const dir = tempWorkspace("landed-peak-");
    writeRawWavs(dir);
    const projectPath = writeProject(dir);
    await expect(landedTrackPeak(projectPath, "Ava")).resolves.toBeCloseTo(
      0.5,
      6,
    );
  });

  it("rejects for a label with no landed track", async () => {
    const dir = tempWorkspace("landed-peak-");
    writeRawWavs(dir);
    const projectPath = writeProject(dir);
    await expect(landedTrackPeak(projectPath, "Nobody")).rejects.toThrow(
      /no landed track labelled/,
    );
    await expect(landedTrackPeak(projectPath, "Nobody")).rejects.toBeInstanceOf(
      LandingPendingError,
    );
  });

  it("rejects a clip with a null source_id", async () => {
    const dir = tempWorkspace("landed-peak-");
    writeRawWavs(dir);
    const projectPath = writeProject(dir, {
      clips: [
        {
          track_id: "t1",
          source_id: null,
          timeline_start: 0,
          source_start: 0,
          source_end: 1,
        },
      ],
    });
    await expect(landedTrackPeak(projectPath, "Ava")).rejects.toThrow(
      /has no source_id/,
    );
  });

  it("rejects when a clip's source is not under raw/", async () => {
    const dir = tempWorkspace("landed-peak-");
    writeRawWavs(dir);
    const projectPath = writeProject(dir, {
      sources: [{ id: "s1", path: "other/a.wav" }],
      clips: [
        {
          track_id: "t1",
          source_id: "s1",
          timeline_start: 0,
          source_start: 0,
          source_end: 1,
        },
      ],
    });
    await expect(landedTrackPeak(projectPath, "Ava")).rejects.toThrow(
      /not under raw\//,
    );
  });

  it("rejects a raw/ path that escapes raw/ via ..", async () => {
    const dir = tempWorkspace("landed-peak-");
    writeRawWavs(dir);
    const projectPath = writeProject(dir, {
      sources: [{ id: "s1", path: "raw/../../a.wav" }],
      clips: [
        {
          track_id: "t1",
          source_id: "s1",
          timeline_start: 0,
          source_start: 0,
          source_end: 1,
        },
      ],
    });
    await expect(landedTrackPeak(projectPath, "Ava")).rejects.toThrow(
      /not under raw\//,
    );
  });

  it("rejects when a source file is missing", async () => {
    const dir = tempWorkspace("landed-peak-");
    fs.mkdirSync(path.join(dir, "raw"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "raw", "a.wav"),
      encodePcmWav(Int16Array.of(0)),
    );
    // raw/b.wav is never written.
    const projectPath = writeProject(dir);
    await expect(landedTrackPeak(projectPath, "Ava")).rejects.toThrow();
  });

  it("rejects for a track with no clips", async () => {
    const dir = tempWorkspace("landed-peak-");
    writeRawWavs(dir);
    const projectPath = writeProject(dir, { clips: [] });
    await expect(landedTrackPeak(projectPath, "Ava")).rejects.toThrow(
      /no landed clips/,
    );
    await expect(landedTrackPeak(projectPath, "Ava")).rejects.toBeInstanceOf(
      LandingPendingError,
    );
  });
});

describe("landedTrackPeakOrPending", () => {
  it("resolves the landed peak", async () => {
    const dir = tempWorkspace("landed-peak-");
    writeRawWavs(dir);
    writeProject(dir);
    await expect(
      landedTrackPeakOrPending(path.join(dir, "episode.project.json"), "Ava"),
    ).resolves.toBeCloseTo(0.5, 6);
  });

  it("resolves to 0 when the project file does not exist yet", async () => {
    const dir = tempWorkspace("landed-peak-");
    await expect(
      landedTrackPeakOrPending(path.join(dir, "episode.project.json"), "Ava"),
    ).resolves.toBe(0);
  });

  it("resolves to 0 for a half-written project JSON", async () => {
    const dir = tempWorkspace("landed-peak-");
    const projectPath = path.join(dir, "episode.project.json");
    fs.writeFileSync(projectPath, "{");
    await expect(landedTrackPeakOrPending(projectPath, "Ava")).resolves.toBe(0);
  });

  it("resolves to 0 before the track lands", async () => {
    const dir = tempWorkspace("landed-peak-");
    writeRawWavs(dir);
    const projectPath = writeProject(dir);
    await expect(landedTrackPeakOrPending(projectPath, "Nobody")).resolves.toBe(
      0,
    );
  });

  it("resolves to 0 before clips land", async () => {
    const dir = tempWorkspace("landed-peak-");
    writeRawWavs(dir);
    const projectPath = writeProject(dir, { clips: [] });
    await expect(landedTrackPeakOrPending(projectPath, "Ava")).resolves.toBe(0);
  });

  it("resolves to 0 while a raw/ WAV is missing", async () => {
    const dir = tempWorkspace("landed-peak-");
    fs.mkdirSync(path.join(dir, "raw"), { recursive: true });
    const projectPath = writeProject(dir);
    await expect(landedTrackPeakOrPending(projectPath, "Ava")).resolves.toBe(0);
  });

  it("rethrows a null source_id", async () => {
    const dir = tempWorkspace("landed-peak-");
    writeRawWavs(dir);
    const projectPath = writeProject(dir, {
      clips: [
        {
          track_id: "t1",
          source_id: null,
          timeline_start: 0,
          source_start: 0,
          source_end: 1,
        },
      ],
    });
    await expect(landedTrackPeakOrPending(projectPath, "Ava")).rejects.toThrow(
      /has no source_id/,
    );
  });

  it("rethrows a source outside raw/", async () => {
    const dir = tempWorkspace("landed-peak-");
    writeRawWavs(dir);
    const projectPath = writeProject(dir, {
      sources: [{ id: "s1", path: "other/a.wav" }],
      clips: [
        {
          track_id: "t1",
          source_id: "s1",
          timeline_start: 0,
          source_start: 0,
          source_end: 1,
        },
      ],
    });
    await expect(landedTrackPeakOrPending(projectPath, "Ava")).rejects.toThrow(
      /not under raw\//,
    );
  });
});

describe("currentTake", () => {
  it("returns the take matching take_index", () => {
    const takes = [
      { take_index: 0, pauses: [] },
      {
        take_index: 1,
        pauses: [{ seq: 1, pause_wall_ms: 0, resume_wall_ms: null }],
      },
    ];
    const snapshot = {
      session_id: "s",
      take_index: 1,
      recording_ms: 0,
      participants: [],
      takes,
    } satisfies HostRecordSnapshot;
    expect(currentTake(snapshot)).toEqual(takes[1]);
  });

  it("throws when the snapshot has no matching take", () => {
    const snapshot = {
      session_id: "s",
      take_index: 2,
      recording_ms: 0,
      participants: [],
      takes: [],
    } satisfies HostRecordSnapshot;
    expect(() => currentTake(snapshot)).toThrow(
      /no open take in record snapshot/,
    );
  });
});

describe("hostRecordConnected", () => {
  it("is true when the host participant is connected", async () => {
    const { page } = hostWithRecordStates([
      {
        session_id: "s",
        take_index: 0,
        recording_ms: 0,
        participants: [
          { participant_id: "p_host", display_name: "Host", connected: true },
        ],
      },
    ]);
    await expect(hostRecordConnected(page as never, "/p/x.json")).resolves.toBe(
      true,
    );
  });

  it("is false when the host participant is disconnected", async () => {
    const { page } = hostWithRecordStates([
      {
        session_id: "s",
        take_index: 0,
        recording_ms: 0,
        participants: [
          { participant_id: "p_host", display_name: "Host", connected: false },
        ],
      },
    ]);
    await expect(hostRecordConnected(page as never, "/p/x.json")).resolves.toBe(
      false,
    );
  });

  it("is false when the host participant is missing", async () => {
    const { page } = hostWithRecordStates([
      {
        session_id: "s",
        take_index: 0,
        recording_ms: 0,
        participants: [],
      },
    ]);
    await expect(hostRecordConnected(page as never, "/p/x.json")).resolves.toBe(
      false,
    );
  });
});

describe("expectRemintRefused", () => {
  it("passes when the remint is refused with 409", async () => {
    const { page } = hostWithResponse(
      false,
      {
        detail:
          "A take is open (REC/PAUSED). Stop it before minting a new room.",
      },
      409,
    );
    await expect(
      expectRemintRefused(page as never, "/p/x.json"),
    ).resolves.toBeUndefined();
  });

  it("fails when the remint is not refused", async () => {
    const { page } = hostWithResponse(true, { room: {} });
    await expect(
      expectRemintRefused(page as never, "/p/x.json"),
    ).rejects.toThrow();
  });
});
