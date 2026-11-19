import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandLocks } from "../test/commandLocks";

import type { QueuedCommand } from "./offlineQueue/offlineStore";

const storage = vi.hoisted(() => ({ rows: [] as QueuedCommand[] }));
vi.mock("./offlineQueue/offlineStore", () => {
  const add = async (_: string, command: QueuedCommand) => {
    const hadPredecessor = storage.rows.length > 0;
    storage.rows.push(command);
    return { persisted: true, hadPredecessor };
  };
  const load = async () => [...storage.rows];
  const remove = async (_: string, id: string) => {
    storage.rows = storage.rows.filter((c) => c.command_id !== id);
  };
  const removeMany = async (_: string, ids: string[]) => {
    storage.rows = storage.rows.filter((c) => !ids.includes(c.command_id));
  };
  const settle = async (_: string, id: string, _o: unknown, drop: boolean) => {
    if (drop) await remove("", id);
  };
  return {
    enqueueCommand: add,
    enqueueHostCommand: add,
    loadCommandQueue: load,
    loadHostCommandQueue: load,
    removeQueuedCommand: remove,
    removeHostQueuedCommand: remove,
    removeQueuedCommands: removeMany,
    removeHostQueuedCommands: removeMany,
    settleHostCommandOutcome: settle,
    settleGuestCommandOutcome: settle,
  };
});
vi.mock("../document/applyDocumentUpdate", () => ({
  applyDocumentResult: vi.fn(),
  refreshDocumentDisplay: vi.fn(),
}));
vi.mock("./offlineQueue/requestDrainLazy", () => ({
  requestHostDrainLazy: vi.fn(),
  requestGuestDrainLazy: vi.fn(),
}));

const PATH = "share:alpha";

async function load(guestMode: "edit" | "comment" | "view" | null) {
  const { useDawStore } = await import("../state/dawStore");
  const { minimalProject } = await import("../test/fixtures");
  const authority = await import("../document/authorityState");
  const stakes = await import("../utils/editStakes");
  const path = guestMode === null ? "/tmp/p.json" : PATH;
  useDawStore.setState({
    projectPath: path,
    project: minimalProject(),
    guestMode,
  });
  authority.resetDocumentAuthority(path);
  const api = await import("./commandQueue");
  return { api, stakes, path };
}

function reply(body: Record<string, unknown>, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status < 400,
      status,
      json: async () => body,
    })),
  );
}

beforeEach(() => {
  vi.resetModules();
  storage.rows = [];
  sessionStorage.clear();
  localStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: commandLocks(),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("the Editor's reminder, raised by an applied edit", () => {
  it("rises after an Editor's applied edit and not again once dismissed", async () => {
    const { api, stakes, path } = await load("edit");
    reply({ history_head_id: "h1" });
    await api.submitQueuedDocumentCommand(path, "SetTrackMeta", { name: "a" });
    expect(stakes.editStakesUp()).toBe(true);
    stakes.markEditStakesSeen("alpha");
    stakes.dismissEditStakes();
    reply({ history_head_id: "h2" });
    await api.submitQueuedDocumentCommand(path, "SetTrackMeta", { name: "b" });
    expect(stakes.editStakesUp()).toBe(false);
  });

  it("rises again for another link in the same browser", async () => {
    const { api, stakes, path } = await load("edit");
    stakes.markEditStakesSeen("beta");
    reply({ history_head_id: "h1" });
    await api.submitQueuedDocumentCommand(path, "SetTrackMeta", { name: "a" });
    expect(stakes.editStakesUp()).toBe(true);
  });

  it("does not rise for an edit that was queued, not applied", async () => {
    const { api, stakes, path } = await load("edit");
    reply({ history_head_id: "h1", queued: true });
    await api.submitQueuedDocumentCommand(path, "SetTrackMeta", { name: "a" });
    expect(stakes.editStakesUp()).toBe(false);
  });

  it("does not rise for an edit that left no history entry", async () => {
    const { api, stakes, path } = await load("edit");
    reply({});
    await api.submitQueuedDocumentCommand(path, "SetTrackMeta", { name: "a" });
    expect(stakes.editStakesUp()).toBe(false);
  });

  it("does not rise for an edit the host's check held", async () => {
    const { api, stakes, path } = await load("edit");
    reply({ detail: "held", code: "cut_scope_changed" }, 400);
    await api.submitQueuedDocumentCommand(path, "SetTrackMeta", { name: "a" });
    expect(stakes.editStakesUp()).toBe(false);
  });

  it("does not rise for Undo", async () => {
    const { api, stakes, path } = await load("edit");
    const authority = await import("../document/authorityState");
    reply({ history_head_id: "h1" });
    await api.submitLiveHistoryCommand(
      path,
      "UndoHistory",
      { expected_head_id: "h0" },
      authority.documentScope(),
    );
    expect(stakes.editStakesUp()).toBe(false);
  });

  it.each(["comment", "view", null] as const)(
    "does not rise for %s",
    async (mode) => {
      const { api, stakes, path } = await load(mode);
      reply({ history_head_id: "h1" });
      await api.submitQueuedDocumentCommand(path, "SetTrackMeta", {
        name: "a",
      });
      expect(stakes.editStakesUp()).toBe(false);
    },
  );
});
