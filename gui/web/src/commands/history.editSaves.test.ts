import { expect, it, vi } from "vitest";
import { trimClipEdge, undoHistory } from "../api";
import { loadBoundaryContext } from "../api/boundary";
import { saveClipEdge } from "../edit/clipEdgeSave";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { ClipRow, HistoryEntryId } from "../types/project";
import { clearRegisteredCommands } from "./execute";
import {
  _resetHistoryMovesForTests,
  registerHistoryCommands,
  runHistoryAction,
} from "./history";

const order: string[] = [];
let releaseBoundary: () => void = () => undefined;

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  undoHistory: vi.fn(
    async (_path: string, args: { expectedHeadId: string }) => {
      order.push(`undo expecting ${args.expectedHeadId}`);
      return "h-before" as HistoryEntryId;
    },
  ),
  trimClipEdge: vi.fn(async () => {
    order.push("trim sent");
    return { asked: false };
  }),
}));
vi.mock("../api/boundary", () => ({
  loadBoundaryContext: vi.fn(
    () =>
      new Promise((resolve) => {
        releaseBoundary = () => resolve({ token: "t" });
      }),
  ),
}));
vi.mock("./trackMix", () => ({ flushPendingMix: vi.fn(async () => {}) }));

it("sends a rail Undo pressed while a strip trim loads its boundary token after the trim", async () => {
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
        head_id: "h0" as HistoryEntryId,
        can_undo: true,
      },
    },
  });
  const clip = {
    id: "c1",
    source_start: 0,
    source_end: 10,
    timeline_start: 0,
    source_id: "s1",
  } as unknown as ClipRow;

  const save = saveClipEdge("/tmp/ep", clip, {
    kind: "trim",
    edge: "out",
    mode: "ripple",
    sourceSec: 9.9,
  });
  runHistoryAction("undo");
  await vi.waitFor(() => expect(loadBoundaryContext).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(order).toEqual([]);

  releaseBoundary();
  await save;
  await vi.waitFor(() => expect(undoHistory).toHaveBeenCalled());
  expect(trimClipEdge).toHaveBeenCalledTimes(1);
  expect(order).toEqual(["trim sent", "undo expecting h0"]);
});
