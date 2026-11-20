import { render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { HistoryPanel } from "../panels/HistoryPanel";
import { useHistoryControls } from "../stage/frame/useHistoryControls";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { COMMANDS } from "./catalog";
import { buildCommandContext, evaluateWhen } from "./context";
import { clearRegisteredCommands, execute } from "./execute";
import { _resetHistoryMovesForTests } from "./history";
import { historyAvailability } from "./historyAvailability";
import { registerDawCommands } from "./register";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  undoHistory: vi.fn(async () => null),
  redoHistory: vi.fn(async () => null),
  loadHistoryDiff: vi.fn(),
}));

const GUEST_UNDO = "There is nothing of yours to undo.";
const GUEST_REDO = "There is nothing of yours to redo.";

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

type Role = keyof typeof ROLES;

function enter(role: Role, canUndo: boolean, canRedo: boolean) {
  useDawStore.setState({
    ...ROLES[role],
    shareCapabilities: ROLES[role].shareCapabilities
      ? [...ROLES[role].shareCapabilities]
      : null,
    project: minimalProject({
      history: {
        ...minimalProject().history,
        can_undo: canUndo,
        can_redo: canRedo,
      },
    }),
    stage: "edit",
  });
}

const OK = { ok: true } as const;
const no = (reason: string) => ({ ok: false, reason }) as const;

const TABLE: {
  role: Role;
  flags: [boolean, boolean];
  undo: ReturnType<typeof no> | typeof OK;
  redo: ReturnType<typeof no> | typeof OK;
}[] = [
  {
    role: "viewer",
    flags: [true, true],
    undo: no("Undo needs Editor access"),
    redo: no("Redo needs Editor access"),
  },
  {
    role: "commenter",
    flags: [true, true],
    undo: no("Undo needs Editor access"),
    redo: no("Redo needs Editor access"),
  },
  { role: "editor", flags: [true, true], undo: OK, redo: OK },
  { role: "editor", flags: [true, false], undo: OK, redo: no(GUEST_REDO) },
  { role: "editor", flags: [false, true], undo: no(GUEST_UNDO), redo: OK },
  {
    role: "editor",
    flags: [false, false],
    undo: no(GUEST_UNDO),
    redo: no(GUEST_REDO),
  },
  { role: "host", flags: [true, true], undo: OK, redo: OK },
  {
    role: "host",
    flags: [false, false],
    undo: no("Nothing to undo"),
    redo: no("Nothing to redo"),
  },
];

describe("historyAvailability", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    _resetHistoryMovesForTests();
    vi.mocked(api.undoHistory).mockClear();
    vi.mocked(api.redoHistory).mockClear();
    useDawStore.getState().hydrate("/tmp/ep", null);
  });

  afterEach(() => {
    useDawStore.getState().hydrate("/tmp/ep", null);
    useDawStore.setState({ guestMode: null, shareCapabilities: null });
  });

  it.each(TABLE)(
    "answers $undo.ok/$redo.ok for $role with flags $flags",
    ({ role, flags, undo, redo }) => {
      enter(role, flags[0], flags[1]);
      expect(historyAvailability(useDawStore.getState())).toEqual({
        undo,
        redo,
      });
    },
  );

  it.each(TABLE)(
    "the command context, header and History tab agree for $role with flags $flags",
    ({ role, flags, undo, redo }) => {
      enter(role, flags[0], flags[1]);
      const ctx = buildCommandContext();
      expect(evaluateWhen(COMMANDS["history.undo"].when, ctx)).toEqual(undo);
      expect(evaluateWhen(COMMANDS["history.redo"].when, ctx)).toEqual(redo);

      const header = renderHook(() => useHistoryControls()).result.current
        .history;
      if (role === "viewer" || role === "commenter") {
        expect(header).toBeNull();
      } else {
        expect(header).toEqual({
          canUndo: undo.ok,
          canRedo: redo.ok,
          undoReason: undo.ok ? undefined : undo.reason,
          redoReason: redo.ok ? undefined : redo.reason,
        });
      }

      const { unmount } = render(<HistoryPanel />);
      expect(
        (screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement)
          .disabled,
      ).toBe(!undo.ok);
      expect(
        (screen.getByRole("button", { name: "Redo" }) as HTMLButtonElement)
          .disabled,
      ).toBe(!redo.ok);
      unmount();
    },
  );

  it("does not send an Editor's key when the flag is false, and says why", async () => {
    enter("editor", false, false);
    expect(await execute("history.undo")).toEqual({
      status: "disabled",
      reason: GUEST_UNDO,
    });
    expect(await execute("history.redo")).toEqual({
      status: "disabled",
      reason: GUEST_REDO,
    });
    expect(api.undoHistory).not.toHaveBeenCalled();
    expect(api.redoHistory).not.toHaveBeenCalled();
  });

  it("keeps an Editor's Undo on while their own save is in flight", async () => {
    const { trackEditSave } = await import("../state/documentSendOrder");
    enter("editor", false, false);
    let release: () => void = () => {};
    const save = trackEditSave(
      "share:tok",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    expect(historyAvailability(useDawStore.getState()).undo).toEqual(OK);
    release();
    await save;
  });
});
