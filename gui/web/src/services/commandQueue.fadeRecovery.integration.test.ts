import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import {
  documentAuthority,
  resetDocumentAuthority,
} from "../document/authorityState";
import { useDawStore } from "../state/dawStore";
import { replayQueuedCommands } from "../state/drainOfflineQueue";
import type { OfflineConflict, QueuedCommand } from "../state/offlineStore";
import { clipRow, minimalProject } from "../test/fixtures";
import { submitQueuedDocumentCommand } from "./commandQueue";

const { queues, conflicts, remove, enqueue, addConflict } = vi.hoisted(() => {
  const queues = new Map<string, QueuedCommand[]>();
  const conflicts = new Map<string, OfflineConflict[]>();
  const remove = async (key: string, id: string) => {
    queues.set(
      key,
      (queues.get(key) ?? []).filter((row) => row.command_id !== id),
    );
  };
  const enqueue = async (key: string, command: QueuedCommand) => {
    await remove(key, command.command_id);
    queues.set(key, [...(queues.get(key) ?? []), command]);
    return { persisted: true, hadPredecessor: false };
  };
  const addConflict = async (key: string, conflict: OfflineConflict) => {
    conflicts.set(key, [...(conflicts.get(key) ?? []), conflict]);
  };
  return { queues, conflicts, remove, enqueue, addConflict };
});
vi.mock("../state/offlineStore", () => ({
  enqueueHostCommand: enqueue,
  enqueueCommand: enqueue,
  removeHostQueuedCommand: remove,
  removeQueuedCommand: remove,
  addHostConflict: addConflict,
  addConflict,
}));

const refusal = "This clip changed. Nothing was saved. Adjust the fade again.";
const payload = {
  clip_id: "clip-1",
  fade_in_ms: 1,
  fade_out_ms: 1,
  expected: { fade_in_ms: 1, fade_out_ms: 0 },
};
const command: QueuedCommand = {
  client_id: "original-client",
  command_id: "original-fade",
  client_seq: 7,
  type: "SetClipFade",
  payload,
  created_at: 1,
};
const project = (path: string, fadeIn = 0, fadeOut = 0) =>
  minimalProject({
    project_path: path,
    clips: {
      tracks: {
        host: [clipRow({ fade_in_ms: fadeIn, fade_out_ms: fadeOut })],
      },
      clip_count: 1,
    },
  });
const snapshot = (path: string) => ({
  server_seq: 2,
  state_token: "a".repeat(64),
  project: project(path),
});
const response = (value: unknown) => new Response(JSON.stringify(value));
const paths = ["/projects/fade.project.json", "share:fade"];
const keyFor = (path: string) => (path.startsWith("share:") ? "fade" : path);

function server(refresh: () => Promise<Response>, code = "clip_fade_changed") {
  const posted: unknown[] = [];
  const fetchSpy = vi.fn(
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") return refresh();
      if (typeof init.body !== "string")
        throw new Error("Expected a JSON command body");
      const body: unknown = JSON.parse(init.body);
      posted.push(body);
      if (
        body &&
        typeof body === "object" &&
        "type" in body &&
        body.type !== "SetClipFade"
      )
        return response({ ok: true });
      return new Response(JSON.stringify({ detail: refusal }), {
        status: 409,
        headers: { "X-Sharecut-Error-Code": code },
      });
    },
  );
  vi.stubGlobal("fetch", fetchSpy);
  return { posted, fetchSpy };
}
function open(path: string) {
  useDawStore.getState().hydrate(path, project(path, 1));
  applyDocumentSnapshot({ server_seq: 1, project: project(path, 1) });
}
function submit(path: string) {
  return submitQueuedDocumentCommand(path, command.type, payload, {
    client_id: command.client_id,
    command_id: command.command_id,
    client_seq: command.client_seq,
  });
}
async function replay(path: string) {
  const key = keyFor(path);
  queues.set(key, [command]);
  await replayQueuedCommands({ path, load: async () => queues.get(key) ?? [] });
}
function expectRefused(path: string, posted: unknown[]) {
  expect(posted).toEqual([
    {
      client_id: "original-client",
      command_id: "original-fade",
      client_seq: 7,
      type: "SetClipFade",
      payload: {
        clip_id: "clip-1",
        fade_in_ms: 1,
        fade_out_ms: 1,
        expected: { fade_in_ms: 1, fade_out_ms: 0 },
      },
      role: path.startsWith("share:") ? "guest" : "viewer",
    },
  ]);
  expect(queues.get(keyFor(path))).toEqual([]);
  expect(conflicts.get(keyFor(path))).toEqual([
    {
      command: { ...command, created_at: expect.any(Number) },
      reason: refusal,
    },
  ]);
}

beforeEach(() => {
  resetDocumentAuthority();
  queues.clear();
  conflicts.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe.each(paths)("fade recovery for %s", (path) => {
  it.each(["live", "replay"])(
    "refreshes saved values after %s refusal without repairing or resending it",
    async (mode) => {
      open(path);
      const { posted, fetchSpy } = server(async () => response(snapshot(path)));
      if (mode === "live")
        await expect(submit(path)).rejects.toMatchObject({
          message: refusal,
          code: "clip_fade_changed",
          status: 409,
        });
      else await replay(path);
      expect(
        useDawStore.getState().project?.clips.tracks.host[0],
      ).toMatchObject({
        fade_in_ms: 0,
        fade_out_ms: 0,
      });
      expect(documentAuthority.seq).toBe(2);
      expect(fetchSpy.mock.calls[1]?.[0]).toBe(
        path.startsWith("share:")
          ? "/api/review/fade/daw/document/state?phase=shell"
          : `/api/document/state?path=${encodeURIComponent(path)}&phase=shell`,
      );
      expectRefused(path, posted);
    },
  );

  it.each(["live", "replay"])(
    "keeps the original refusal and permanent dequeue when %s refresh fails",
    async (mode) => {
      open(path);
      const { posted } = server(async () => {
        throw new TypeError("refresh offline");
      });
      if (mode === "live")
        await expect(submit(path)).rejects.toMatchObject({
          message: refusal,
          code: "clip_fade_changed",
          status: 409,
        });
      else await replay(path);
      expectRefused(path, posted);
      expect(
        useDawStore.getState().project?.clips.tracks.host[0].fade_in_ms,
      ).toBe(1);
    },
  );

  it("continues replay past the permanent refusal when refresh fails", async () => {
    open(path);
    const { posted } = server(async () => {
      throw new TypeError("refresh offline");
    });
    const key = keyFor(path);
    queues.set(key, [
      command,
      {
        ...command,
        command_id: "next-command",
        client_seq: 8,
        type: "SetTrackMeta",
        payload: { track_id: "host", label: "Next" },
      },
    ]);
    await replayQueuedCommands({
      path,
      load: async () => queues.get(key) ?? [],
      settle: async (completed) => {
        for (const id of completed) await remove(key, id);
      },
    });
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({
      command_id: "next-command",
      client_seq: 8,
    });
    expectRefused(path, posted.slice(0, 1));
  });

  it.each(["other project", "same path reopened"])(
    "does not apply a delayed refresh after switching to %s",
    async (destination) => {
      open(path);
      let resolveRefresh = (_response: Response) => {};
      const refresh = new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      });
      const { posted, fetchSpy } = server(() => refresh);
      const settled = expect(submit(path)).rejects.toMatchObject({
        message: refusal,
      });
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
      const other = "/projects/other.project.json";
      open(other);
      const next = destination === "same path reopened" ? path : other;
      open(next);
      const current = useDawStore.getState().project;
      resolveRefresh(response(snapshot(path)));
      await settled;
      expect(useDawStore.getState().project).toBe(current);
      expect(documentAuthority.path).toBe(next);
      expect(documentAuthority.seq).toBe(1);
      expectRefused(path, posted);
    },
  );

  it("does not refresh when the project switches before the refusal arrives", async () => {
    open(path);
    let resolvePost = (_response: Response) => {};
    const reply = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    const fetchSpy = vi.fn(() => reply);
    vi.stubGlobal("fetch", fetchSpy);
    const outcome = submit(path).catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    open("/projects/other.project.json");
    const current = useDawStore.getState().project;
    resolvePost(
      new Response(JSON.stringify({ detail: refusal }), {
        status: 409,
        headers: { "X-Sharecut-Error-Code": "clip_fade_changed" },
      }),
    );
    expect(await outcome).toMatchObject({
      message: refusal,
      code: "clip_fade_changed",
      status: 409,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(useDawStore.getState().project).toBe(current);
    expect(queues.get(keyFor(path))).toEqual([]);
    expect(conflicts.get(keyFor(path))?.[0].reason).toBe(refusal);
  });

  it("does not refresh an inactive project's refusal", async () => {
    open("/projects/other.project.json");
    const { posted, fetchSpy } = server(async () => response(snapshot(path)));
    await expect(submit(path)).rejects.toMatchObject({ message: refusal });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(documentAuthority.path).toBe("/projects/other.project.json");
    expectRefused(path, posted);
  });

  it("does not refresh an unrelated conflict", async () => {
    open(path);
    const { fetchSpy } = server(
      async () => response(snapshot(path)),
      "other_conflict",
    );
    await expect(submit(path)).rejects.toMatchObject({
      code: "other_conflict",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
