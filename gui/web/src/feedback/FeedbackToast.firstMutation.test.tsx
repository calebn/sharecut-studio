import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { undoHistory } from "../api";
import { loadDocumentState } from "../api/project";
import { clearRegisteredCommands } from "../commands/execute";
import {
  _resetHistoryMovesForTests,
  registerHistoryCommands,
} from "../commands/history";
import {
  applyDocumentResult,
  applyDocumentSnapshot,
} from "../document/applyDocumentUpdate";
import {
  activateDocumentScope,
  resetDocumentAuthority,
} from "../document/authorityState";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { HistoryEntryId } from "../types/project";
import { FeedbackToast } from "./FeedbackToast";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  undoHistory: vi.fn(async () => null),
}));
vi.mock("../api/project", () => ({
  loadDocumentState: vi.fn(() => new Promise(() => {})),
}));
vi.mock("../document/hydrateTranscriptDetail", () => ({
  scheduleTranscriptDetailHydrate: vi.fn(),
}));

const token = "b".repeat(64);
const path = "/tmp/first-mutation.json";
const entry = (id: string) => id as HistoryEntryId;

/** The project as a page load shows it: history head known, its groups not fetched. */
function freshLoad() {
  const loaded = minimalProject({
    project_path: path,
    history: {
      cursor: 49,
      head_id: entry("8e522f1d3dd5"),
      can_undo: true,
      can_redo: true,
      groups: [],
    },
  });
  loaded.meta.hydration = { transcript_words: true, history_groups: false };
  return loaded;
}

/** What the host sends for one command: the whole history, as it holds it. */
function firstMutationResult(headId: string) {
  return {
    command: { command_id: "first", server_seq: 1 },
    history_head_id: headId,
    snapshot: {
      server_seq: 1,
      state_token: token,
      file_before: { mtime_ns: 1, size: 1 },
      file: { mtime_ns: 2, size: 1 },
      delta: {
        base_seq: 0,
        base_token: token,
        projection: "transcript_audio",
        audience: "host",
        operations: [
          {
            type: "replace",
            section: "history",
            parent: null,
            value: {
              cursor: 50,
              head_id: headId,
              can_undo: true,
              can_redo: false,
            },
          },
          {
            type: "rows",
            section: "history_groups",
            parent: null,
            before_count: 47,
            splices: [
              {
                index: 46,
                delete: 1,
                insert: [
                  {
                    kind: "mutation",
                    before_index: 49,
                    after_index: 50,
                    before_id: "8e522f1d3dd5",
                    after_id: headId,
                    label: "set words ignored",
                    operation: null,
                    params: null,
                    created_at: "2026-10-13T07:09:43+00:00",
                    title: "set words ignored",
                  },
                ],
              },
            ],
            updates: [],
          },
        ],
      },
    },
  };
}

describe("the first mutation on a fresh page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        callback: (
          entries: { isIntersecting: boolean; intersectionRatio: number }[],
        ) => void;
        constructor(
          callback: (
            entries: { isIntersecting: boolean; intersectionRatio: number }[],
          ) => void,
        ) {
          this.callback = callback;
        }
        observe() {
          this.callback([{ isIntersecting: true, intersectionRatio: 1 }]);
        }
        disconnect() {}
      },
    );
    clearRegisteredCommands();
    registerHistoryCommands();
    _resetHistoryMovesForTests();
    resetDocumentAuthority();
    useDawStore.getState().hydrate(path, freshLoad());
    activateDocumentScope(path);
    applyDocumentSnapshot({
      server_seq: 0,
      state_token: token,
      project: freshLoad(),
      file: { mtime_ns: 1, size: 1 },
    });
  });

  it("shows the new head at once, without refetching, though History was never opened", () => {
    applyDocumentResult(firstMutationResult("1b0040fb2927"));
    expect(loadDocumentState).not.toHaveBeenCalled();
    const { history, meta } = useDawStore.getState().project!;
    expect(history.head_id).toBe("1b0040fb2927");
    expect(history.can_redo).toBe(false);
    expect(meta.hydration?.history_groups).toBe(false);
  });

  it("offers Undo on the first mutation's toast and undoes that entry", async () => {
    const user = userEvent.setup();
    render(<FeedbackToast />);
    applyDocumentResult(firstMutationResult("1b0040fb2927"));
    act(() => {
      useDawStore
        .getState()
        .announceStatus("Ignored selection", { undo: entry("1b0040fb2927") });
    });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(undoHistory).toHaveBeenCalledWith(path, {
      scope: activateDocumentScope(path),
      expectedHeadId: "1b0040fb2927",
    });
  });
});
