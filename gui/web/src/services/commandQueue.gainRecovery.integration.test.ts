import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import {
  documentAuthority,
  resetDocumentAuthority,
} from "../document/authorityState";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject } from "../test/fixtures";
import { submitQueuedDocumentCommand } from "./commandQueue";
import type {
  OfflineConflict,
  QueuedCommand,
} from "./offlineQueue/offlineStore";

const { queues, conflicts, remove, enqueue, addConflict, settle } = vi.hoisted(
  () => {
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
    const settle = async (
      key: string,
      id: string,
      outcome: OfflineConflict | null,
      removeFromQueue: boolean,
    ) => {
      if (removeFromQueue) await remove(key, id);
      if (outcome)
        conflicts.set(key, [
          ...(conflicts.get(key) ?? []).filter(
            (row) => row.command.command_id !== id,
          ),
          outcome,
        ]);
      else
        conflicts.set(
          key,
          (conflicts.get(key) ?? []).filter(
            (row) => row.command.command_id !== id,
          ),
        );
    };
    return { queues, conflicts, remove, enqueue, addConflict, settle };
  },
);
vi.mock("./offlineQueue/offlineStore", () => ({
  enqueueHostCommand: enqueue,
  enqueueCommand: enqueue,
  removeHostQueuedCommand: remove,
  removeQueuedCommand: remove,
  addHostConflict: addConflict,
  addConflict,
  settleHostCommandOutcome: settle,
  settleGuestCommandOutcome: settle,
}));

const refusal = "This clip changed. Nothing was saved. Adjust the gain again.";
const CASES = {
  SetClipGain: {
    clip_id: "clip-1",
    gain_db: 6,
    expected: { gain_db: 0 },
  },
  SetClipsGain: {
    gains: [{ clip_id: "clip-1", gain_db: 6, expected: { gain_db: 0 } }],
  },
} as const;
const project = (path: string, gain = 0) =>
  minimalProject({
    project_path: path,
    clips: {
      tracks: { host: [clipRow({ gain_db: gain })] },
      clip_count: 1,
    },
  });
const snapshot = (path: string) => ({
  server_seq: 2,
  state_token: "a".repeat(64),
  project: project(path),
});
const response = (value: unknown) => new Response(JSON.stringify(value));
const paths = ["/projects/gain.project.json", "share:gain"];
const keyFor = (path: string) => (path.startsWith("share:") ? "gain" : path);

function server(refresh: () => Promise<Response>, code = "clip_gain_changed") {
  const fetchSpy = vi.fn(
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") return refresh();
      return new Response(JSON.stringify({ detail: refusal }), {
        status: 409,
        headers: { "X-Sharecut-Error-Code": code },
      });
    },
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}
function open(path: string) {
  useDawStore.getState().hydrate(path, project(path, 6));
  applyDocumentSnapshot({ server_seq: 1, project: project(path, 6) });
}
function submit(path: string, type: keyof typeof CASES) {
  return submitQueuedDocumentCommand(
    path,
    type,
    { ...CASES[type] },
    {
      client_id: "original-client",
      command_id: `original-${type}`,
      client_seq: 7,
    },
  );
}

beforeEach(() => {
  resetDocumentAuthority();
  queues.clear();
  conflicts.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe.each(paths)("gain recovery for %s", (path) => {
  it.each(Object.keys(CASES) as (keyof typeof CASES)[])(
    "refreshes the saved gain after a %s refusal without resending it",
    async (type) => {
      open(path);
      const fetchSpy = server(async () => response(snapshot(path)));
      await expect(submit(path, type)).rejects.toMatchObject({
        message: refusal,
        code: "clip_gain_changed",
        status: 409,
      });
      expect(
        useDawStore.getState().project?.clips.tracks.host[0].gain_db ?? 0,
      ).toBe(0);
      expect(documentAuthority.seq).toBe(2);
      expect(fetchSpy.mock.calls[1]?.[0]).toBe(
        path.startsWith("share:")
          ? "/api/review/gain/daw/document/state?phase=shell"
          : `/api/document/state?path=${encodeURIComponent(path)}&phase=shell`,
      );
      expect(
        fetchSpy.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
      expect(conflicts.get(keyFor(path))?.[0]).toMatchObject({
        kind: "refused",
        reason: refusal,
      });
    },
  );

  it("keeps the refusal when the refresh fails", async () => {
    open(path);
    server(async () => {
      throw new TypeError("refresh offline");
    });
    await expect(submit(path, "SetClipGain")).rejects.toMatchObject({
      message: refusal,
      code: "clip_gain_changed",
    });
    expect(useDawStore.getState().project?.clips.tracks.host[0].gain_db).toBe(
      6,
    );
  });

  it("does not refresh an unrelated conflict", async () => {
    open(path);
    const fetchSpy = server(
      async () => response(snapshot(path)),
      "other_conflict",
    );
    await expect(submit(path, "SetClipGain")).rejects.toMatchObject({
      code: "other_conflict",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
