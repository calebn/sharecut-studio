import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redoHistory, undoHistory } from "../api";
import { clearRegisteredCommands } from "../commands/execute";
import {
  _resetHistoryMovesForTests,
  registerHistoryCommands,
} from "../commands/history";
import { useDawStore } from "../state/dawStore";
import {
  beginHostSend,
  HOST_SEND_WAIT_MS,
  noteSaveLanded,
} from "../state/hostSendOrder";
import { minimalProject } from "../test/fixtures";
import { HISTORY_ROOT_ID } from "../types/project";
import { CompactHistoryControls } from "./HistoryControls";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  undoHistory: vi.fn(async () => HISTORY_ROOT_ID),
  redoHistory: vi.fn(async () => HISTORY_ROOT_ID),
}));
vi.mock("../commands/trackMix", () => ({
  flushPendingMix: vi.fn(async () => {}),
}));

beforeEach(() => {
  clearRegisteredCommands();
  registerHistoryCommands();
  _resetHistoryMovesForTests();
  vi.mocked(undoHistory).mockClear();
  vi.mocked(redoHistory).mockClear();
  useDawStore.getState().hydrate(
    "/tmp/history-controls",
    minimalProject({
      history: {
        ...minimalProject().history,
        head_id: HISTORY_ROOT_ID,
        can_undo: true,
        can_redo: true,
      },
    }),
  );
});

afterEach(() => vi.useRealTimers());

describe("CompactHistoryControls", () => {
  it.each(["view", "comment"] as const)(
    "offers no history mutation to a %s guest",
    (guestMode) => {
      useDawStore.setState({
        projectPath: "share:reader",
        guestMode,
        shareCapabilities: ["view", "comment"],
      });
      render(<CompactHistoryControls />);
      expect(
        screen.queryByRole("button", { name: "Undo" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Redo" }),
      ).not.toBeInTheDocument();
      expect(undoHistory).not.toHaveBeenCalled();
      expect(redoHistory).not.toHaveBeenCalled();
    },
  );

  it("uses authorized guest history availability and the same command path", async () => {
    useDawStore.setState({
      projectPath: "share:editor",
      guestMode: "edit",
      shareCapabilities: ["view", "edit"],
    });
    render(<CompactHistoryControls />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(undoHistory).toHaveBeenCalledWith("share:editor", {
        expectedHeadId: HISTORY_ROOT_ID,
      }),
    );
  });

  for (const action of ["undo", "redo"] as const) {
    const label = action === "undo" ? "Undo" : "Redo";
    const move = action === "undo" ? undoHistory : redoHistory;
    it(`waits for this tab's save before header ${label}`, async () => {
      const save = beginHostSend("/tmp/history-controls", `save-${action}`);
      render(<CompactHistoryControls />);
      fireEvent.click(screen.getByRole("button", { name: label }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(move).not.toHaveBeenCalled();
      noteSaveLanded("/tmp/history-controls", HISTORY_ROOT_ID);
      save.finish();
      await waitFor(() =>
        expect(move).toHaveBeenCalledWith("/tmp/history-controls", {
          expectedHeadId: HISTORY_ROOT_ID,
        }),
      );
    });

    it(`refuses header ${label} while a save remains pending`, async () => {
      vi.useFakeTimers();
      const save = beginHostSend("/tmp/history-controls", `stalled-${action}`);
      try {
        render(<CompactHistoryControls />);
        fireEvent.click(screen.getByRole("button", { name: label }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(HOST_SEND_WAIT_MS);
        });
        expect(move).not.toHaveBeenCalled();
        expect(useDawStore.getState().statusAnnouncement).toBe(
          `Your last edit is still saving. Nothing was ${action === "undo" ? "undone" : "redone"}.`,
        );
      } finally {
        save.finish();
      }
    });
  }
});
