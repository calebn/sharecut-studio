import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  applyDocumentSnapshot,
  recoverDocument,
} from "../document/applyDocumentUpdate";
import {
  documentScope,
  resetDocumentAuthority,
} from "../document/authorityState";
import { useDawStore } from "../state/dawStore";
import { selectedClipIdsOf, tracksSelection } from "../state/selection";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

const { queued } = vi.hoisted(() => ({
  queued: new Map<
    string,
    Array<{ command_id: string; payload: Record<string, unknown> }>
  >(),
}));
vi.mock("../services/offlineQueue/offlineStore", () => {
  const enqueue = async (
    path: string,
    command: { command_id: string; payload: Record<string, unknown> },
  ) => {
    const before = queued.get(path) ?? [];
    queued.set(path, [...before, command]);
    return { persisted: true, hadPredecessor: before.length > 0 };
  };
  const settle = async (
    path: string,
    id: string,
    _outcome: unknown,
    remove: boolean,
  ) => {
    if (remove)
      queued.set(
        path,
        (queued.get(path) ?? []).filter((row) => row.command_id !== id),
      );
  };
  return {
    enqueueHostCommand: enqueue,
    enqueueCommand: enqueue,
    loadHostCommandQueue: vi.fn(async (path: string) => queued.get(path) ?? []),
    loadCommandQueue: vi.fn(async (path: string) => queued.get(path) ?? []),
    settleHostCommandOutcome: settle,
    settleGuestCommandOutcome: settle,
    removeHostConflictsWhere: vi.fn(async () => {}),
    removeConflictsWhere: vi.fn(async () => {}),
    removeHostQueuedCommand: vi.fn(),
    removeQueuedCommand: vi.fn(),
  };
});

const path = "/tmp/split-recovery.sharecut";
const before = minimalProject({
  tracks: [sampleTrack({ id: "host" })],
  clips: {
    tracks: {
      host: [clipRow({ id: "left", track_id: "host", timeline_end: 20 })],
    },
    clip_count: 1,
  },
});
const after = minimalProject({
  tracks: before.tracks,
  clips: {
    tracks: {
      host: [
        clipRow({ id: "left", track_id: "host", timeline_end: 10 }),
        clipRow({
          id: "right",
          track_id: "host",
          timeline_start: 10,
          timeline_end: 20,
          source_start: 10,
          source_end: 20,
        }),
      ],
    },
    clip_count: 2,
  },
});
const response = (data: unknown) => new Response(JSON.stringify(data));
let resolveRecovery: (value: Response) => void;
let fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  queued.clear();
  resetDocumentAuthority(path);
  useDawStore.getState().hydrate(path, before);
  applyDocumentSnapshot({ server_seq: 1, project: before });
  useDawStore.setState({
    selection: tracksSelection(["host"]),
    guestMode: null,
    shareCapabilities: null,
    feedbackToast: null,
  });
  clearRegisteredCommands();
  registerDawCommands();
  const recovery = new Promise<Response>((resolve) => {
    resolveRecovery = resolve;
  });
  fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? response({
          ok: true,
          split_outcome: {
            kind: "split",
            times: [10],
            pieces: [{ track_id: "host", clip_id: "right" }],
          },
          snapshot: { server_seq: 3, resync: true },
          command: { type: "SplitAtTime" },
        })
      : recovery,
  );
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("selects the right piece after real command-queue snapshot recovery completes", async () => {
  const split = execute("edit.bladeCut", { atTime: 10 }, { skipWhen: true });
  let result: unknown;
  void split.then((value) => {
    result = value;
  });
  await vi.waitFor(() =>
    expect(fetchSpy, JSON.stringify(result)).toHaveBeenCalledTimes(2),
  );
  expect(selectedClipIdsOf(useDawStore.getState().selection)).toEqual([]);
  const recovered = recoverDocument(3);
  resolveRecovery(
    response({ server_seq: 3, state_token: "b".repeat(64), project: after }),
  );
  await split;
  await recovered;
  expect(selectedClipIdsOf(useDawStore.getState().selection)).toEqual([
    "right",
  ]);
});

it("returns applied success while recovery is still pending", async () => {
  const split = execute("edit.bladeCut", { atTime: 10 }, { skipWhen: true });
  await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  expect(await split).toEqual({ status: "ok" });
  expect(useDawStore.getState().feedbackToast?.message).toBe(
    "Split at 00:10.000",
  );
  const recovered = recoverDocument(3);
  resolveRecovery(
    response({ server_seq: 3, state_token: "b".repeat(64), project: after }),
  );
  await recovered;
});

it.each(["selection", "reopen"] as const)(
  "preserves a newer %s during recovery",
  async (change) => {
    const split = execute("edit.bladeCut", { atTime: 10 }, { skipWhen: true });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    const recovered = recoverDocument(3);
    if (change === "reopen") {
      resetDocumentAuthority(path);
      useDawStore.getState().hydrate(path, before);
    }
    const held = tracksSelection([]);
    useDawStore.getState().setSelection(held);
    resolveRecovery(
      response({ server_seq: 3, state_token: "b".repeat(64), project: after }),
    );
    await recovered;
    await split;
    expect(useDawStore.getState().selection).toBe(held);
  },
);

it("keeps applied success when authoritative recovery fails", async () => {
  const split = execute("edit.bladeCut", { atTime: 10 }, { skipWhen: true });
  await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  const recovered = recoverDocument(3, documentScope());
  const failure = expect(recovered).rejects.toThrow();
  resolveRecovery(new Response("Recovery unavailable", { status: 503 }));
  await failure;
  expect(await split).toEqual({ status: "ok" });
  expect(useDawStore.getState().feedbackToast?.message).toBe(
    "Split at 00:10.000",
  );
  expect(selectedClipIdsOf(useDawStore.getState().selection)).toEqual([]);
  applyDocumentSnapshot({
    server_seq: 3,
    state_token: "b".repeat(64),
    project: after,
  });
  expect(selectedClipIdsOf(useDawStore.getState().selection)).toEqual([]);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

it("keeps the second live Split's right piece selected after serialized saves", async () => {
  let firstReply!: (value: Response) => void;
  let secondReply!: (value: Response) => void;
  const firstResponse = new Promise<Response>((resolve) => {
    firstReply = resolve;
  });
  const secondResponse = new Promise<Response>((resolve) => {
    secondReply = resolve;
  });
  let posts = 0;
  fetchSpy.mockImplementation(
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") throw new Error("Unexpected recovery GET");
      return ++posts === 1 ? firstResponse : secondResponse;
    },
  );
  const first = execute("edit.bladeCut", { atTime: 5 }, { skipWhen: true });
  await vi.waitFor(() => expect(posts).toBe(1));
  const second = execute("edit.bladeCut", { atTime: 8 }, { skipWhen: true });
  await vi.waitFor(() => expect(queued.get(path)).toHaveLength(2));
  const projection = (start: number, leftId: string, rightId: string) =>
    minimalProject({
      tracks: before.tracks,
      clips: {
        tracks: {
          host: [
            clipRow({ id: leftId, track_id: "host", timeline_end: start }),
            clipRow({
              id: rightId,
              track_id: "host",
              timeline_start: start,
              timeline_end: 20,
              source_start: start,
              source_end: 20,
            }),
          ],
        },
        clip_count: 2,
      },
    });
  firstReply(
    response({
      ok: true,
      split_outcome: {
        kind: "split",
        times: [5],
        pieces: [{ track_id: "host", clip_id: "first-right" }],
      },
      snapshot: {
        server_seq: 2,
        project: projection(5, "first-left", "first-right"),
      },
    }),
  );
  await first;
  await vi.waitFor(() => expect(posts).toBe(2));
  const final = projection(8, "second-left", "second-right");
  final.clips.tracks.host.unshift(
    clipRow({ id: "first-left", track_id: "host", timeline_end: 5 }),
  );
  final.clips.tracks.host[1].timeline_start = 5;
  final.clips.tracks.host[1].source_start = 5;
  final.clips.clip_count = 3;
  secondReply(
    response({
      ok: true,
      split_outcome: {
        kind: "split",
        times: [8],
        pieces: [{ track_id: "host", clip_id: "second-right" }],
      },
      snapshot: { server_seq: 3, project: final },
    }),
  );
  await second;
  expect(selectedClipIdsOf(useDawStore.getState().selection)).toEqual([
    "second-right",
  ]);
  expect(useDawStore.getState().feedbackToast?.message).toBe(
    "Split at 00:08.000",
  );
});

it("selects a WebSocket-recovered display before the pending recovery GET fails", async () => {
  const split = execute("edit.bladeCut", { atTime: 10 }, { skipWhen: true });
  await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  await split;
  const attempt = recoverDocument(3);
  const failure = expect(attempt).rejects.toThrow();
  try {
    applyDocumentSnapshot({
      server_seq: 3,
      state_token: "b".repeat(64),
      project: after,
    });
    expect(selectedClipIdsOf(useDawStore.getState().selection)).toEqual([
      "right",
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  } finally {
    resolveRecovery(new Response("Recovery unavailable", { status: 503 }));
    await failure;
  }
  expect(selectedClipIdsOf(useDawStore.getState().selection)).toEqual([
    "right",
  ]);
});
