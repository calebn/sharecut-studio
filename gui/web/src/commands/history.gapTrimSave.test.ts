import { expect, it, vi } from "vitest";
import { loadBoundaryContext } from "../api/boundary";
import { saveClipEdge } from "../edit/clipEdgeSave";
import { submitLiveHistoryCommand } from "../services/commandQueue";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import type { HistoryEntryId } from "../types/project";
import { clearRegisteredCommands } from "./execute";
import {
  _resetHistoryMovesForTests,
  registerHistoryCommands,
  runHistoryAction,
} from "./history";

const sent: string[] = [];
let releaseBoundary: () => void = () => undefined;

vi.mock("../services/commandQueue", () => ({
  submitQueuedDocumentCommand: vi.fn(
    async (_path: string, type: string, payload: Record<string, unknown>) => {
      sent.push(
        type === "TrimClipEdge" ? `trim ${String(payload.mode)}` : type,
      );
      return { history_head_id: "h-after" };
    },
  ),
  submitLiveHistoryCommand: vi.fn(async (_path: string, type: string) => {
    sent.push(type);
    return { history_head_id: "h-after" };
  }),
}));
vi.mock("../api/boundary", () => ({
  loadBoundaryContext: vi.fn(
    () =>
      new Promise((resolve) => {
        releaseBoundary = () => resolve({ token: "gap-token" });
      }),
  ),
}));
vi.mock("./trackMix", () => ({ flushPendingMix: vi.fn(async () => {}) }));

it("holds Undo while a manual gap trim loads its boundary token until the trim is sent", async () => {
  clearRegisteredCommands();
  registerHistoryCommands();
  _resetHistoryMovesForTests();
  const project = minimalProject({
    tracks: [sampleTrack({ id: "host", duration_sec: 10 })],
    clips: {
      tracks: { host: [clipRow({ id: "c1", track_id: "host" })] },
      clip_count: 1,
    },
  });
  useDawStore.setState({
    projectPath: "/tmp/ep",
    project: {
      ...project,
      history: {
        ...project.history,
        head_id: "h0" as HistoryEntryId,
        can_undo: true,
      },
    },
  });

  const gap = saveClipEdge("/tmp/ep", project.clips.tracks.host[0], {
    kind: "trim",
    edge: "out",
    sourceSec: 1.5,
    mode: "gap",
  });
  runHistoryAction("undo");
  await vi.waitFor(() => expect(loadBoundaryContext).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toEqual([]);

  releaseBoundary();
  await gap;
  await vi.waitFor(() =>
    expect(submitLiveHistoryCommand).toHaveBeenCalledTimes(1),
  );
  expect(sent).toEqual(["trim gap", "UndoHistory"]);
});
