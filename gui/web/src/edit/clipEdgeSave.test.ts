import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { undoHistory } from "../api";
import { DOCUMENT_COMMAND_TIMEOUT_MS } from "../api/documentTransport";
import { clearRegisteredCommands, execute } from "../commands/execute";
import {
  _resetHistoryMovesForTests,
  registerHistoryCommands,
} from "../commands/history";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject } from "../test/fixtures";
import type { HistoryEntryId } from "../types/project";
import { saveClipEdge } from "./clipEdgeSave";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  undoHistory: vi.fn(async () => null),
}));
vi.mock("../commands/trackMix", () => ({
  flushPendingMix: vi.fn(async () => {}),
}));

beforeEach(() => {
  clearRegisteredCommands();
  registerHistoryCommands();
  _resetHistoryMovesForTests();
  const project = minimalProject();
  useDawStore.setState({
    projectPath: "/tmp/ep",
    project: {
      ...project,
      history: {
        ...project.history,
        head_id: "h1" as HistoryEntryId,
        can_undo: true,
        can_redo: false,
      },
    },
    statusAnnouncement: "",
  });
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("a trim whose boundary token never loads drops its save, and Undo works again", async () => {
  const save = saveClipEdge(
    "/tmp/ep",
    clipRow({ id: "c1", track_id: "t1", source_start: 0, source_end: 5 }),
    { kind: "trim", edge: "out", mode: "ripple", sourceSec: 4 },
  );
  const failure = expect(save).rejects.toThrow(
    "The server didn't answer. Nothing was saved.",
  );

  const refused = execute("history.undo");
  await vi.advanceTimersByTimeAsync(5_000);
  await refused;
  expect(useDawStore.getState().statusAnnouncement).toBe(
    "Your last edit is still saving. Nothing was undone.",
  );
  expect(undoHistory).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(DOCUMENT_COMMAND_TIMEOUT_MS);
  await failure;

  await execute("history.undo");
  expect(undoHistory).toHaveBeenCalledTimes(1);
});
