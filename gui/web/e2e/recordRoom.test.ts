import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodePcmWav } from "../src/audio/wavHeader";
import {
  clickHostTransport,
  createRecordRoom,
  ensureHostRecordCommand,
  landedTrackPeak,
  markSharecutE2e,
  openRecordLink,
  recordLinkPath,
} from "./recordRoom";

const room = {
  session_id: "sess-1",
  guest: { token: "guest-token" },
  producer: { token: "producer-token" },
};

function hostWithResponse(ok: boolean, body: unknown) {
  const post = vi.fn(async () => ({
    ok: () => ok,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }));
  return { page: { request: { post } }, post };
}

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
 * resolves with `post`.
 */
function hostWithRecordStates(
  states: string[],
  post: { ok: boolean; body?: unknown },
) {
  let call = 0;
  const get = vi.fn(async () => {
    const state = states[Math.min(call, states.length - 1)];
    call += 1;
    return {
      ok: () => true,
      text: async () => JSON.stringify({ state }),
      json: async () => ({
        state,
        session_id: "s",
        take_index: 0,
        recording_ms: 0,
        participants: [],
      }),
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

describe("landedTrackPeak", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0)) {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  function workspace(): string {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), "landed-peak-"));
    workspaces.push(value);
    return value;
  }

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

  it("resolves the peak across every landed source on the track", async () => {
    const dir = workspace();
    writeRawWavs(dir);
    const projectPath = writeProject(dir);
    await expect(landedTrackPeak(projectPath, "Ava")).resolves.toBeCloseTo(
      0.5,
      6,
    );
  });

  it("rejects for a label with no landed track", async () => {
    const dir = workspace();
    writeRawWavs(dir);
    const projectPath = writeProject(dir);
    await expect(landedTrackPeak(projectPath, "Nobody")).rejects.toThrow(
      /no landed track labelled/,
    );
  });

  it("rejects when a clip's source is not under raw/", async () => {
    const dir = workspace();
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

  it("rejects when a source file is missing", async () => {
    const dir = workspace();
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
    const dir = workspace();
    writeRawWavs(dir);
    const projectPath = writeProject(dir, { clips: [] });
    await expect(landedTrackPeak(projectPath, "Ava")).rejects.toThrow(
      /no landed clips/,
    );
  });
});
