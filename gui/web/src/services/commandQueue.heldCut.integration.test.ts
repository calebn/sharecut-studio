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
vi.mock("./offlineQueue/requestDrainLazy", () => ({
  requestHostDrainLazy: vi.fn(),
  requestGuestDrainLazy: vi.fn(),
}));
vi.mock("./offlineQueue/offlineStore", () => ({
  loadHostCommandQueue,
  loadCommandQueue,
  enqueueHostCommand,
  enqueueCommand,
  removeHostConflictsWhere: vi.fn(),
  removeConflictsWhere: vi.fn(),
  removeHostQueuedCommand: vi.fn(),
  removeQueuedCommand: vi.fn(),
  settleHostCommandOutcome,
  settleGuestCommandOutcome,
}));

const HELD =
  "Reference's cut at 0:02.5 was not applied because the full recording is not available right now. Nothing was changed.";

describe.each([
  { side: "host", path: "/tmp/episode.sharecut", filed: "refused" },
  { side: "guest", path: "share:tok", filed: null },
])("a cut held by a placement check on the $side", ({ side, path, filed }) => {
  const settle =
    side === "host" ? settleHostCommandOutcome : settleGuestCommandOutcome;
  const post =
    side === "host" ? postHostDocumentCommand : postGuestDocumentCommand;
  const enqueue = side === "host" ? enqueueHostCommand : enqueueCommand;
  const identity = { client_id: "c", command_id: "cmd-1", client_seq: 3 };
  const held = {
    ok: false,
    status: 400,
    failure: new ApiError(HELD, "cut_scope_changed", 400),
  };

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
    post.mockResolvedValue(held);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function send(replaying: boolean) {
    const { submitDocumentCommand } = await import("../api");
    return submitDocumentCommand(
      path,
      "EditSelectedRange",
      { label: "x" },
      replaying ? { ...identity, replaying: true } : identity,
    );
  }

  it(`files ${filed === null ? "no" : "a"} Needs attention row and still throws the sentence`, async () => {
    await expect(send(false)).rejects.toMatchObject({ message: HELD });
    expect(settle.mock.calls[0]?.[2]?.kind ?? null).toBe(filed);
  });

  it("files a row when the held command was a replay", async () => {
    await expect(send(true)).rejects.toMatchObject({ message: HELD });
    expect(settle.mock.calls[0]?.[2]?.kind).toBe("refused");
  });
});
