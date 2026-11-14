import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { COMMANDS } from "./catalog";
import { buildCommandContext, evaluateWhen } from "./context";
import { clearRegisteredCommands, execute, listRegisteredIds } from "./execute";
import { _resetHistoryMovesForTests } from "./history";
import { registerDawCommands } from "./register";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  undoHistory: vi.fn(async () => null),
  redoHistory: vi.fn(async () => null),
}));

const LISTEN_ONLY_MUTES = new Set([
  "track.muteToggle",
  "edit.mute",
  "track.soloToggle",
]);

const ROLES = {
  host: { projectPath: "/tmp/ep", guestMode: null, shareCapabilities: null },
  editor: {
    projectPath: "share:tok",
    guestMode: "edit",
    shareCapabilities: ["view", "play", "comment", "edit"],
  },
  commenter: {
    projectPath: "share:tok",
    guestMode: "comment",
    shareCapabilities: ["view", "play", "comment"],
  },
  viewer: {
    projectPath: "share:tok",
    guestMode: "view",
    shareCapabilities: ["view", "play"],
  },
} as const;

const OPEN_HISTORY = {
  ...minimalProject().history,
  can_undo: true,
  can_redo: true,
};

type Role = keyof typeof ROLES;
const CAN_EDIT: Record<Role, boolean> = {
  host: true,
  editor: true,
  commenter: false,
  viewer: false,
};
const ROLE_NAMES = Object.keys(ROLES) as Role[];

function resetStore() {
  useDawStore.getState().hydrate("/tmp/ep", null);
  useDawStore.setState({
    guestMode: null,
    shareCapabilities: null,
    stage: "edit",
  });
}

function enterRole(role: Role) {
  useDawStore.setState({
    ...ROLES[role],
    shareCapabilities: ROLES[role].shareCapabilities
      ? [...ROLES[role].shareCapabilities]
      : null,
    project: minimalProject({ history: OPEN_HISTORY }),
    stage: "edit",
  });
}

function enabledIds(): string[] {
  const ctx = buildCommandContext();
  return listRegisteredIds().filter(
    (id) => evaluateWhen(COMMANDS[id].when, ctx).ok,
  );
}

describe("role gating of history commands", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    _resetHistoryMovesForTests();
    vi.mocked(api.undoHistory).mockClear();
    vi.mocked(api.redoHistory).mockClear();
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  it.each(ROLE_NAMES)(
    "offers undo and redo to %s only with Editor access",
    (role) => {
      enterRole(role);
      const ctx = buildCommandContext();
      for (const when of ["canUndo", "canRedo"] as const) {
        expect(evaluateWhen(when, ctx).ok).toBe(CAN_EDIT[role]);
      }
      const enabled = enabledIds();
      expect(enabled.includes("history.undo")).toBe(CAN_EDIT[role]);
      expect(enabled.includes("history.redo")).toBe(CAN_EDIT[role]);
    },
  );

  it.each(["commenter", "viewer"] as const)(
    "tells %s that undo and redo need Editor access",
    (role) => {
      enterRole(role);
      const ctx = buildCommandContext();
      expect(evaluateWhen("canUndo", ctx)).toEqual({
        ok: false,
        reason: "Undo needs Editor access",
      });
      expect(evaluateWhen("canRedo", ctx)).toEqual({
        ok: false,
        reason: "Redo needs Editor access",
      });
    },
  );

  it.each(["commenter", "viewer"] as const)(
    "refuses history.undo and history.redo for %s without calling the server",
    async (role) => {
      enterRole(role);
      for (const skipWhen of [false, true]) {
        const undo = await execute("history.undo", {}, { skipWhen });
        const redo = await execute("history.redo", {}, { skipWhen });
        expect(undo).toMatchObject({
          status: "disabled",
          reason: "Undo needs Editor access",
        });
        expect(redo).toMatchObject({
          status: "disabled",
          reason: "Redo needs Editor access",
        });
      }
      expect(api.undoHistory).not.toHaveBeenCalled();
      expect(api.redoHistory).not.toHaveBeenCalled();
    },
  );

  it("lets an Editor's history.undo reach the server", async () => {
    enterRole("editor");
    const result = await execute("history.undo", {});
    expect(result.status).not.toBe("disabled");
    expect(api.undoHistory).toHaveBeenCalledTimes(1);
  });

  it("offers history-related mutating commands only to host and Editor", () => {
    const historyMutating = (id: string) =>
      COMMANDS[id].category === "history" ||
      (COMMANDS[id].mutates === true && /undo|redo|history/i.test(id));
    for (const role of ROLE_NAMES) {
      enterRole(role);
      const offered = enabledIds().filter(
        (id) => historyMutating(id) && !LISTEN_ONLY_MUTES.has(id),
      );
      if (CAN_EDIT[role]) {
        expect(offered).toEqual(
          expect.arrayContaining(["history.undo", "history.redo"]),
        );
      } else {
        expect(offered).toEqual([]);
      }
    }
  });

  it("keeps the listen-only mute commands registered for every role", () => {
    for (const role of ROLE_NAMES) {
      enterRole(role);
      const ids = listRegisteredIds();
      for (const id of LISTEN_ONLY_MUTES) expect(ids).toContain(id);
    }
  });
});
