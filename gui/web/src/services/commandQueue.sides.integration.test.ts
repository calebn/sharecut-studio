import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandLocks } from "../test/commandLocks";
import { ApiError } from "../utils/apiError";

const enqueueHostCommand = vi.fn();
const enqueueCommand = vi.fn();
const loadHostCommandQueue = vi.fn();
const loadCommandQueue = vi.fn();
const settleHostCommandOutcome = vi.fn();
const settleGuestCommandOutcome = vi.fn();
const postHostDocumentCommand = vi.fn();
const postGuestDocumentCommand = vi.fn();

vi.mock("../document/applyDocumentUpdate", () => ({
  applyDocumentResult: vi.fn(),
  refreshDocumentDisplay: vi.fn(),
}));
vi.mock("../api/documentTransport", () => ({
  postHostDocumentCommand,
  postGuestDocumentCommand,
}));
vi.mock("../state/offlineStore", () => ({
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

  async function run(replaying: boolean) {
    const { submitDocumentCommand } = await import("../api");
    try {
      const result = await submitDocumentCommand(
        path,
        "SetTrackMeta",
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
