import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandLocks } from "../test/commandLocks";
import type { DocumentCommandType } from "../types/documentCommands.generated";
import { ApiError } from "../utils/apiError";

const enqueueHostCommand = vi.fn();
const enqueueCommand = vi.fn();
const loadHostCommandQueue = vi.fn();
const loadCommandQueue = vi.fn();
const settleHostCommandOutcome = vi.fn();
const settleGuestCommandOutcome = vi.fn();
const postHostDocumentCommand = vi.fn();
const postGuestDocumentCommand = vi.fn();
const requestHostDrainLazy = vi.fn();
const requestGuestDrainLazy = vi.fn();

vi.mock("../document/applyDocumentUpdate", () => ({
  applyDocumentResult: vi.fn(),
  refreshDocumentDisplay: vi.fn(),
}));
vi.mock("../api/documentTransport", () => ({
  postHostDocumentCommand,
  postGuestDocumentCommand,
}));
vi.mock("./offlineQueue/requestDrainLazy", () => ({
  requestHostDrainLazy,
  requestGuestDrainLazy,
}));
vi.mock("./offlineQueue/offlineStore", () => ({
  loadHostCommandQueue,
  loadCommandQueue,
  enqueueHostCommand,
  enqueueCommand,
  removeHostQueuedCommand: vi.fn(),
  removeQueuedCommand: vi.fn(),
  settleHostCommandOutcome,
  settleGuestCommandOutcome,
}));

/**
 * Pins how the host and the share-guest submit paths settle each transport
 * outcome, so the two bodies can share one implementation without changing
 * when a command stays queued, is removed, or throws.
 */
describe.each([
  { side: "host", path: "/tmp/episode.project.json", col: 0 },
  { side: "guest", path: "share:tok", col: 1 },
])("$side command outcomes", ({ side, path, col }) => {
  const settle =
    side === "host" ? settleHostCommandOutcome : settleGuestCommandOutcome;
  const post =
    side === "host" ? postHostDocumentCommand : postGuestDocumentCommand;
  const enqueue = side === "host" ? enqueueHostCommand : enqueueCommand;

  beforeEach(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: commandLocks(),
    });
    sessionStorage.clear();
    vi.resetModules();
    vi.clearAllMocks();
    enqueue.mockResolvedValue({ persisted: true, hadPredecessor: false });
    loadHostCommandQueue.mockResolvedValue([]);
    loadCommandQueue.mockResolvedValue([]);
    settle.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  const identity = {
    client_id: "c",
    command_id: "cmd-1",
    client_seq: 3,
  };

  async function run(
    replaying: boolean,
    type: DocumentCommandType = "SetTrackMeta",
  ) {
    const { submitDocumentCommand } = await import("../api");
    try {
      const result = await submitDocumentCommand(
        path,
        type,
        { label: "x" },
        replaying ? { ...identity, replaying: true } : identity,
      );
      return { result, thrown: null as unknown };
    } catch (thrown) {
      return { result: null, thrown };
    }
  }
  const settled = () => {
    const [, , outcome, remove] = settle.mock.calls[0] ?? [];
    return { kind: outcome?.kind ?? null, remove };
  };
  const ok = { ok: true, data: { ok: true } };
  const retryLater = {
    ok: false,
    status: 503,
    failure: new ApiError("busy", null, 503),
  };
  const refused = {
    ok: false,
    status: 400,
    failure: new ApiError("bad", null, 400),
  };

  const refineGate = {
    ok: false,
    status: 409,
    failure: new ApiError(
      "Transcript refine is required. Run `podcast transcript refine-waive`.",
      "transcript_refine_required",
      409,
    ),
  };

  type Expected = {
    kind: string | null;
    remove: boolean | undefined;
    end: "returns" | "queued" | "throws";
  };
  // [host, guest] per scenario. The sides differ when a replayed send does not
  // land (host reports it queued, guest rethrows) and in whether a landed
  // replay removes its row (the host drain batch-removes it; a guest replay
  // removes its own). A host send with nothing persisted throws before it
  // settles anything.
  const cases: [string, boolean, () => void, [Expected, Expected], boolean?][] =
    [
      [
        "lands",
        false,
        () => post.mockResolvedValue(ok),
        [
          { kind: null, remove: true, end: "returns" },
          { kind: null, remove: true, end: "returns" },
        ],
      ],
      [
        "lands",
        true,
        () => post.mockResolvedValue(ok),
        [
          { kind: null, remove: false, end: "returns" },
          { kind: null, remove: true, end: "returns" },
        ],
      ],
      [
        "transport error",
        false,
        () => post.mockRejectedValue(new Error("offline")),
        [
          { kind: "unknown", remove: false, end: "queued" },
          { kind: "unknown", remove: false, end: "queued" },
        ],
      ],
      [
        "transport error",
        true,
        () => post.mockRejectedValue(new Error("offline")),
        [
          { kind: "unknown", remove: false, end: "queued" },
          { kind: "unknown", remove: false, end: "throws" },
        ],
      ],
      [
        "503",
        false,
        () => post.mockResolvedValue(retryLater),
        [
          { kind: "unknown", remove: false, end: "queued" },
          { kind: "unknown", remove: false, end: "queued" },
        ],
      ],
      [
        "503",
        true,
        () => post.mockResolvedValue(retryLater),
        [
          { kind: "unknown", remove: false, end: "queued" },
          { kind: "unknown", remove: false, end: "throws" },
        ],
      ],
      [
        "400",
        false,
        () => post.mockResolvedValue(refused),
        [
          { kind: "refused", remove: true, end: "throws" },
          { kind: "refused", remove: true, end: "throws" },
        ],
      ],
      [
        "400",
        true,
        () => post.mockResolvedValue(refused),
        [
          { kind: "refused", remove: true, end: "throws" },
          { kind: "refused", remove: true, end: "throws" },
        ],
      ],
      [
        "refine gate 409",
        true,
        () => post.mockResolvedValue(refineGate),
        [
          { kind: "refused", remove: true, end: "throws" },
          { kind: "refused", remove: true, end: "throws" },
        ],
      ],
      [
        "transport error, nothing persisted",
        false,
        () => {
          enqueue.mockResolvedValue({
            persisted: false,
            hadPredecessor: false,
          });
          post.mockRejectedValue(new Error("offline"));
        },
        [
          { kind: null, remove: undefined, end: "throws" },
          { kind: "unknown", remove: false, end: "throws" },
        ],
      ],
    ];

  it("answers a live ApproveEdits refine-gate refusal inline on the host only", async () => {
    post.mockResolvedValue(refineGate);
    const { thrown } = await run(false, "ApproveEdits");
    expect(thrown).toBeInstanceOf(Error);
    expect(settled()).toEqual({
      kind: col === 0 ? null : "refused",
      remove: true,
    });
  });

  it("records a live refine-gate refusal of any other command", async () => {
    post.mockResolvedValue(refineGate);
    await run(false, "SetTrackMeta");
    expect(settled()).toEqual({ kind: "refused", remove: true });
  });

  it("records a replayed ApproveEdits refine-gate refusal instead of dropping it", async () => {
    post.mockResolvedValue(refineGate);
    await run(true, "ApproveEdits");
    expect(settled()).toEqual({ kind: "refused", remove: true });
  });

  it("tells a replayed refine-gate refusal in plain words, without commands", async () => {
    post.mockResolvedValue(refineGate);
    await run(true);
    const outcome = settle.mock.calls[0]?.[2];
    expect(outcome?.reason).toBe(
      "This is blocked until transcript refinement is done. A host can review the transcript or waive it with a reason.",
    );
  });

  it.each(cases)(
    "%s (replaying=%s)",
    async (_name, replaying, arrange, expected) => {
      arrange();
      const { result, thrown } = await run(replaying);
      const want = expected[col];
      expect(settled()).toEqual({ kind: want.kind, remove: want.remove });
      if (want.end === "throws") {
        expect(thrown).toBeInstanceOf(Error);
      } else {
        expect(thrown).toBeNull();
        expect(result).toEqual(
          want.end === "queued"
            ? { ok: true, queued: true, command_id: "cmd-1", client_seq: 3 }
            : { ok: true },
        );
      }
    },
  );
});

describe.each([
  { side: "host", path: "/tmp/episode.project.json" },
  { side: "guest", path: "share:tok" },
])("$side behind an earlier command", ({ side, path }) => {
  const host = side === "host";
  const post = host ? postHostDocumentCommand : postGuestDocumentCommand;
  const enqueue = host ? enqueueHostCommand : enqueueCommand;
  const load = host ? loadHostCommandQueue : loadCommandQueue;
  const drain = host ? requestHostDrainLazy : requestGuestDrainLazy;

  beforeEach(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: commandLocks(),
    });
    sessionStorage.clear();
    vi.resetModules();
    vi.clearAllMocks();
    enqueue.mockResolvedValue({ persisted: true, hadPredecessor: true });
    settleHostCommandOutcome.mockResolvedValue(undefined);
    settleGuestCommandOutcome.mockResolvedValue(undefined);
    post.mockResolvedValue({ ok: true, data: { ok: true } });
  });

  async function submit() {
    const { submitDocumentCommand } = await import("../api");
    return submitDocumentCommand(
      path,
      "SetTrackMeta",
      { label: "mine" },
      {
        client_id: "c",
        command_id: "cmd-1",
        client_seq: 3,
      },
    );
  }

  it("sends the command when it is the head of the queue, adopting the queued payload on the host only", async () => {
    load.mockResolvedValue([
      {
        command_id: "cmd-1",
        client_id: "c",
        client_seq: 3,
        type: "SetTrackMeta",
        payload: { label: "queued" },
        created_at: 1,
      },
    ]);
    await expect(submit()).resolves.toEqual({ ok: true });
    expect(post.mock.calls[0]?.at(-1)).toMatchObject({
      payload: { label: host ? "queued" : "mine" },
    });
    expect(drain).not.toHaveBeenCalled();
  });

  it("stays queued and asks for a drain when an older command is ahead", async () => {
    load.mockResolvedValue([
      {
        command_id: "older",
        client_id: "c",
        client_seq: 2,
        type: "SetTrackMeta",
        payload: {},
        created_at: 1,
      },
    ]);
    await expect(submit()).resolves.toEqual({
      ok: true,
      queued: true,
      command_id: "cmd-1",
      client_seq: 3,
    });
    expect(post).not.toHaveBeenCalled();
    expect(drain).toHaveBeenCalledTimes(1);
  });
});

describe("host persistence fallback", () => {
  const path = "/tmp/episode.project.json";

  beforeEach(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: commandLocks(),
    });
    sessionStorage.clear();
    vi.resetModules();
    vi.clearAllMocks();
    enqueueHostCommand.mockImplementation(
      async (_path: string, _cmd: unknown, onFail: () => void) => {
        onFail();
        throw new Error("storage unavailable");
      },
    );
    settleHostCommandOutcome.mockResolvedValue(undefined);
    postHostDocumentCommand.mockResolvedValue({ ok: true, data: { ok: true } });
  });

  async function submit() {
    const { submitDocumentCommand } = await import("../api");
    return submitDocumentCommand(path, "SetTrackMeta", { label: "x" });
  }

  it("sends directly when a readable queue is empty", async () => {
    loadHostCommandQueue.mockResolvedValue([]);
    await expect(submit()).resolves.toEqual({ ok: true });
    expect(postHostDocumentCommand).toHaveBeenCalledTimes(1);
    // Nothing was persisted, so landing removes no row.
    expect(settleHostCommandOutcome.mock.calls[0]?.[3]).toBe(false);
  });

  it("refuses to send past older offline edits", async () => {
    loadHostCommandQueue.mockResolvedValue([{ command_id: "older" }]);
    await expect(submit()).rejects.toThrow(
      "Cannot send this edit while older offline edits are pending",
    );
    expect(postHostDocumentCommand).not.toHaveBeenCalled();
  });

  it("rethrows the storage error when the queue cannot be read", async () => {
    loadHostCommandQueue.mockRejectedValue(new Error("unreadable"));
    await expect(submit()).rejects.toThrow("storage unavailable");
    expect(postHostDocumentCommand).not.toHaveBeenCalled();
  });
});

describe("guest offline structural edits", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: commandLocks(),
    });
    sessionStorage.clear();
    vi.resetModules();
    vi.clearAllMocks();
    enqueueCommand.mockResolvedValue({
      persisted: true,
      hadPredecessor: false,
    });
    settleGuestCommandOutcome.mockResolvedValue(undefined);
    postGuestDocumentCommand.mockResolvedValue({
      ok: true,
      data: { ok: true },
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function submit(type: "DeleteClip" | "SetTrackMeta") {
    const { submitDocumentCommand } = await import("../api");
    return submitDocumentCommand("share:tok", type, {});
  }

  it("proposes a structural command while offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await submit("DeleteClip");
    expect(enqueueCommand.mock.calls[0]?.[1]).toMatchObject({
      structural_mode: "propose",
    });
    expect(postGuestDocumentCommand.mock.calls[0]?.[1]).toMatchObject({
      structural_mode: "propose",
      role: "guest",
    });
  });

  it("leaves a non-structural command and an online send unmarked", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await submit("SetTrackMeta");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    await submit("DeleteClip");
    for (const [, cmd] of enqueueCommand.mock.calls) {
      expect(cmd.structural_mode).toBeUndefined();
    }
    for (const [, body] of postGuestDocumentCommand.mock.calls) {
      expect(body).not.toHaveProperty("structural_mode");
    }
  });
});
