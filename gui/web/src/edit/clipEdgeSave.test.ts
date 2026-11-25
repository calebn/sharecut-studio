import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { undoHistory } from "../api";
import { setClipFade } from "../api/documentEdits";
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
import { saveNudge } from "./nudge";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  undoHistory: vi.fn(async () => null),
}));
vi.mock("../api/documentEdits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/documentEdits")>()),
  setClipFade: vi.fn(async () => null),
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

it("a trim whose boundary token never loads drops its save, and an Undo pressed meanwhile waits for it instead of being refused", async () => {
  const save = saveClipEdge(
    "/tmp/ep",
    clipRow({ id: "c1", track_id: "t1", source_start: 0, source_end: 5 }),
    { kind: "trim", edge: "out", mode: "ripple", sourceSec: 4 },
  );
  const failure = expect(save).rejects.toThrow(
    "The server didn't answer. Nothing was saved.",
  );

  const queued = execute("history.undo");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(useDawStore.getState().statusAnnouncement).toBe(
    "Undo runs after save",
  );
  expect(undoHistory).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(DOCUMENT_COMMAND_TIMEOUT_MS);
  await failure;
  await queued;
  expect(undoHistory).toHaveBeenCalledTimes(1);
  expect(useDawStore.getState().statusAnnouncement).not.toMatch(/still saving/);
});

it("a fade save on a curved clip carries both curves in its baseline, so the server does not refuse it", async () => {
  const clip = clipRow({
    id: "c1",
    track_id: "t1",
    fade_in_ms: 10,
    fade_out_ms: 20,
    fade_out_curve: "s",
  });
  await saveClipEdge("/tmp/ep", clip, { kind: "fade", inMs: 30, outMs: 20 });
  expect(setClipFade).toHaveBeenLastCalledWith("/tmp/ep", "c1", 30, 20, {
    fade_in_ms: 10,
    fade_out_ms: 20,
    fade_in_curve: "linear",
    fade_out_curve: "s",
  });
});

it("a nudged fade length carries the clip's curves in its baseline and leaves them out of the change", async () => {
  const clip = clipRow({
    id: "c1",
    track_id: "t1",
    fade_in_ms: 10,
    fade_in_curve: "equal_power",
  });
  const origin = minimalProject({
    clips: { tracks: { t1: [clip] }, clip_count: 1 },
  });
  await saveNudge(
    "/tmp/ep",
    origin,
    { kind: "fade", trackId: "t1", clipId: "c1", edge: "out" },
    40,
    () => true,
    () => {},
  );
  expect(setClipFade).toHaveBeenLastCalledWith("/tmp/ep", "c1", 10, 40, {
    fade_in_ms: 10,
    fade_out_ms: 0,
    fade_in_curve: "equal_power",
    fade_out_curve: "linear",
  });
});
