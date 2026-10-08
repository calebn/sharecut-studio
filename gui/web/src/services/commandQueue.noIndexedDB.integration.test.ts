import { afterEach, describe, expect, it, vi } from "vitest";

describe("host document commands without IndexedDB", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails closed without posting when a live command cannot be persisted", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { enqueueHostCommand } = await import("../state/offlineStore");
    await expect(
      enqueueHostCommand("/no-indexeddb", {
        client_id: "client",
        command_id: "probe",
        client_seq: 1,
        type: "SetTrackMeta",
        payload: {},
        created_at: 1,
      }),
    ).resolves.toEqual({ persisted: false, hadPredecessor: false });

    const { submitQueuedDocumentCommand } = await import("./commandQueue");
    await expect(
      submitQueuedDocumentCommand(
        "/no-indexeddb",
        "SetTrackMeta",
        {},
        { client_id: "client", command_id: "live", client_seq: 2 },
      ),
    ).rejects.toThrow(/persist/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
