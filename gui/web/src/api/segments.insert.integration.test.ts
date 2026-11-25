import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commandLocks } from "../test/commandLocks";

vi.mock("../services/offlineQueue/offlineStore", () => ({
  enqueueHostCommand: async () => ({ persisted: true, hadPredecessor: false }),
  removeHostQueuedCommand: async () => undefined,
  removeHostQueuedCommands: async () => undefined,
  loadHostCommandQueue: async () => [],
  settleHostCommandOutcome: async () => undefined,
}));
vi.mock("../document/applyDocumentUpdate", () => ({
  applyDocumentResult: vi.fn(),
  applyDocumentSnapshot: vi.fn(),
  refreshDocumentDisplay: vi.fn(),
  redisplayDrafts: vi.fn(),
}));
vi.mock("../services/offlineQueue/requestDrainLazy", () => ({
  requestHostDrainLazy: vi.fn(),
  requestGuestDrainLazy: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: commandLocks(),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("keeps the server's refusal code on the command queue path", async () => {
  const path = "/tmp/insert-refusal.sharecut";
  const { useDawStore } = await import("../state/dawStore");
  const { minimalProject } = await import("../test/fixtures");
  useDawStore.setState({ projectPath: path, project: minimalProject() });
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify({ detail: "The audio changed." }), {
        status: 400,
        headers: { "X-Sharecut-Error-Code": "segment_hash_mismatch" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const { insertSegment, segmentInsertRefusal } = await import("./segments");
  const caught = await insertSegment(path, {
    segment_id: "warm-intro-1",
    at: "end",
    version: 1,
  }).catch((error: unknown) => error);
  expect(segmentInsertRefusal(caught)).toBe("segment_hash_mismatch");
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body).toMatchObject({
    type: "InsertSegment",
    payload: { segment_id: "warm-intro-1", at: "end", version: 1 },
  });
});
