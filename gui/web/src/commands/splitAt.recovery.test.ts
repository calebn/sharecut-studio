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

vi.mock("../services/offlineQueue/offlineStore", () => ({
  enqueueHostCommand: vi.fn(async () => ({
    persisted: true,
    hadPredecessor: false,
  })),
  enqueueCommand: vi.fn(async () => ({
    persisted: true,
    hadPredecessor: false,
  })),
  loadHostCommandQueue: vi.fn(async () => []),
  loadCommandQueue: vi.fn(async () => []),
  settleHostCommandOutcome: vi.fn(async () => {}),
  settleGuestCommandOutcome: vi.fn(async () => {}),
  removeHostConflictsWhere: vi.fn(async () => {}),
  removeConflictsWhere: vi.fn(async () => {}),
  removeHostQueuedCommand: vi.fn(async () => {}),
  removeQueuedCommand: vi.fn(async () => {}),
}));

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
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
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
});
