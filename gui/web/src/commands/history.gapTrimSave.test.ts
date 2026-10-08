import { expect, it, vi } from "vitest";
import { trimClipEdge } from "../api";
import { loadBoundaryContext } from "../api/boundary";
import { submitQueuedDocumentCommand } from "../services/commandQueue";
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
      return type === "TrimClipEdge" && payload.mode === "ripple"
        ? {
            needs_confirmation: {
              speech: { spans: [{ start: 0, end: 1 }], tracks: [{}] },
            },
          }
        : { history_head_id: "h-after" };
    },
  ),
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

it("holds an Undo pressed while a Leave a gap trim loads its boundary token until the trim is sent", async () => {
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

  const asked = await trimClipEdge("/tmp/ep", "c1", "out", 1.5, "ripple", "t");
  expect(asked.asked).toBe(true);
  const leaveGap = useDawStore.getState().cutSpeechPrompt?.leaveGap;
  if (!leaveGap) throw new Error("the prompt offers no Leave a gap");
  const gap = leaveGap();
  runHistoryAction("undo");
  await vi.waitFor(() => expect(loadBoundaryContext).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toEqual(["trim ripple"]);

  releaseBoundary();
  await gap;
  await vi.waitFor(() =>
    expect(submitQueuedDocumentCommand).toHaveBeenCalledTimes(3),
  );
  expect(sent).toEqual(["trim ripple", "trim gap", "UndoHistory"]);
});
