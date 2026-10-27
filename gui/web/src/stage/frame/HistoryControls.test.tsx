import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redoHistory, undoHistory } from "../../api";
import { clearRegisteredCommands } from "../../commands/execute";
import {
  _resetHistoryMovesForTests,
  registerHistoryCommands,
} from "../../commands/history";
import {
  activateDocumentScope,
  documentScope,
} from "../../document/authorityState";
import { useDawStore } from "../../state/dawStore";
import {
  beginDocumentSend,
  DOCUMENT_SEND_WAIT_MS,
  noteSaveLanded,
} from "../../state/documentSendOrder";
import { minimalProject } from "../../test/fixtures";
import { HISTORY_ROOT_ID } from "../../types/project";
import { CompactHistoryControls, HistoryControls } from "./HistoryControls";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  undoHistory: vi.fn(async () => HISTORY_ROOT_ID),
  redoHistory: vi.fn(async () => HISTORY_ROOT_ID),
}));
vi.mock("../../commands/trackMix", () => ({
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
  it.each(["undo", "redo"] as const)(
    "shows the compact %s caption until its 3500 ms expiry",
    async (action) => {
      vi.useFakeTimers();
      const available = { canUndo: true, canRedo: true };
      const props = {
        history: {
          ...available,
          [action === "undo" ? "canUndo" : "canRedo"]: false,
        },
        onUndo: vi.fn(),
        onRedo: vi.fn(),
      };
      const { rerender } = render(<HistoryControls {...props} />);
      const button = screen.getByRole("button", {
        name: action === "undo" ? "Undo" : "Redo",
      });
      fireEvent.click(button);
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveAccessibleDescription(
        action === "undo" ? "Nothing to undo" : "Nothing to redo",
      );
      expect(
        button.querySelector(".compact-history-caption")?.textContent,
      ).toBe(`No${action}`);
      expect(button.querySelector("svg")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        action === "undo" ? "Nothing to undo" : "Nothing to redo",
      );
      expect(vi.getTimerCount()).toBe(1);
      await act(() => {
        vi.advanceTimersByTime(3499);
      });
      expect(
        button.querySelector(".compact-history-caption"),
      ).toBeInTheDocument();
      await act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(
        screen
          .getByRole("button", { name: action === "undo" ? "Undo" : "Redo" })
          .querySelector(".compact-history-caption"),
      ).toBeNull();
      expect(screen.getByRole("status")).toBeEmptyDOMElement();

      rerender(<HistoryControls {...props} />);
      fireEvent.click(button);
      await act(() => {
        vi.advanceTimersByTime(3499);
      });
      expect(
        button.querySelector(".compact-history-caption"),
      ).toBeInTheDocument();
      fireEvent.click(button);
      await act(() => {
        vi.advanceTimersByTime(3499);
      });
      expect(
        screen
          .getByRole("button", { name: action === "undo" ? "Undo" : "Redo" })
          .querySelector(".compact-history-caption"),
      ).toBeInTheDocument();
      await act(() => {
        vi.advanceTimersByTime(1);
      });
      rerender(<HistoryControls {...props} />);
      expect(
        screen
          .getByRole("button", { name: action === "undo" ? "Undo" : "Redo" })
          .querySelector(".compact-history-caption"),
      ).toBeNull();
    },
  );

  it.each(["undo", "redo"] as const)(
    "ends the old %s activation on recovery",
    async (action) => {
      vi.useFakeTimers();
      const label = action === "undo" ? "Undo" : "Redo";
      const reason = action === "undo" ? "Nothing to undo" : "Nothing to redo";
      const props = {
        history: {
          canUndo: action !== "undo",
          canRedo: action !== "redo",
        },
        onUndo: vi.fn(),
        onRedo: vi.fn(),
      };
      const { rerender } = render(<HistoryControls {...props} />);
      const button = screen.getByRole("button", { name: label });
      fireEvent.click(button);
      expect(screen.getByRole("status")).toHaveTextContent(reason);
      await act(() => {
        vi.advanceTimersByTime(1000);
      });
      rerender(
        <HistoryControls
          {...props}
          history={{ canUndo: true, canRedo: true }}
        />,
      );
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      expect(button.querySelector(".compact-history-caption")).toBeNull();
      rerender(<HistoryControls {...props} />);
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      expect(button.querySelector(".compact-history-caption")).toBeNull();
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveAccessibleDescription(reason);
      fireEvent.click(button);
      expect(screen.getByRole("status")).toHaveTextContent(reason);
      await act(() => {
        vi.advanceTimersByTime(3499);
      });
      expect(screen.getByRole("status")).toHaveTextContent(reason);
      await act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
    },
  );

  it.each(["undo", "redo"] as const)(
    "does not revive the old %s activation after history disappears",
    async (action) => {
      vi.useFakeTimers();
      const label = action === "undo" ? "Undo" : "Redo";
      const reason = action === "undo" ? "Nothing to undo" : "Nothing to redo";
      const props = {
        history: {
          canUndo: action !== "undo",
          canRedo: action !== "redo",
        },
        onUndo: vi.fn(),
        onRedo: vi.fn(),
      };
      const { rerender } = render(<HistoryControls {...props} />);
      const button = screen.getByRole("button", { name: label });
      fireEvent.click(button);
      expect(screen.getByRole("status")).toHaveTextContent(reason);
      await act(() => {
        vi.advanceTimersByTime(1000);
      });
      rerender(<HistoryControls {...props} history={null} />);
      expect(screen.queryByRole("group", { name: "Undo and redo" })).toBeNull();
      rerender(<HistoryControls {...props} />);

      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      const restoredButton = screen.getByRole("button", { name: label });
      expect(restoredButton).toHaveAttribute("aria-disabled", "true");
      expect(restoredButton).toHaveAccessibleDescription(reason);
      expect(
        restoredButton.querySelector(".compact-history-caption"),
      ).toBeNull();

      fireEvent.click(restoredButton);
      expect(screen.getByRole("status")).toHaveTextContent(reason);
      await act(() => {
        vi.advanceTimersByTime(3499);
      });
      expect(screen.getByRole("status")).toHaveTextContent(reason);
      await act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
    },
  );

  it.each(["undo", "redo"] as const)(
    "keeps the original %s expiry when availability is replaced with an equivalent object",
    async (action) => {
      vi.useFakeTimers();
      const props = {
        history: {
          canUndo: action !== "undo",
          canRedo: action !== "redo",
        },
        onUndo: vi.fn(),
        onRedo: vi.fn(),
      };
      const { rerender } = render(<HistoryControls {...props} />);
      fireEvent.click(
        screen.getByRole("button", {
          name: action === "undo" ? "Undo" : "Redo",
        }),
      );
      await act(() => {
        vi.advanceTimersByTime(1000);
      });
      rerender(<HistoryControls {...props} history={{ ...props.history }} />);

      await act(() => {
        vi.advanceTimersByTime(2499);
      });
      expect(screen.getByRole("status")).toHaveTextContent(
        action === "undo" ? "Nothing to undo" : "Nothing to redo",
      );
      await act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
    },
  );

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
    const scopeAtPress = activateDocumentScope("share:editor");
    render(<CompactHistoryControls />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(undoHistory).toHaveBeenCalledWith("share:editor", {
        scope: scopeAtPress,
        expectedHeadId: HISTORY_ROOT_ID,
      }),
    );
  });

  for (const action of ["undo", "redo"] as const) {
    const label = action === "undo" ? "Undo" : "Redo";
    const move = action === "undo" ? undoHistory : redoHistory;
    it(`waits for this tab's save before header ${label}`, async () => {
      const scopeAtPress = documentScope();
      const save = beginDocumentSend("/tmp/history-controls", `save-${action}`);
      render(<CompactHistoryControls />);
      fireEvent.click(screen.getByRole("button", { name: label }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(move).not.toHaveBeenCalled();
      noteSaveLanded("/tmp/history-controls", HISTORY_ROOT_ID, documentScope());
      save.finish();
      await waitFor(() =>
        expect(move).toHaveBeenCalledWith("/tmp/history-controls", {
          scope: scopeAtPress,
          expectedHeadId: HISTORY_ROOT_ID,
        }),
      );
    });

    it(`says header ${label} is ready after the save while one runs, and that it runs after the save once pressed`, async () => {
      const save = beginDocumentSend("/tmp/history-controls", `hint-${action}`);
      try {
        render(<CompactHistoryControls />);
        const button = screen.getByRole("button", { name: label });
        expect(button).toHaveAccessibleDescription(`${label} ready after save`);
        expect(button).toHaveAttribute("title", `${label} ready after save`);
        fireEvent.click(button);
        await act(async () => {
          await Promise.resolve();
        });
        expect(useDawStore.getState().statusAnnouncement).toBe(
          `${label} runs after save`,
        );
        noteSaveLanded(
          "/tmp/history-controls",
          HISTORY_ROOT_ID,
          documentScope(),
        );
        save.finish();
        await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
        expect(
          screen.getByRole("button", { name: label }),
        ).not.toHaveAccessibleDescription(`${label} ready after save`);
      } finally {
        save.finish();
      }
    });

    it(`keeps header ${label} waiting while a save stays pending, with no refusal`, async () => {
      vi.useFakeTimers();
      const scopeAtPress = documentScope();
      const save = beginDocumentSend(
        "/tmp/history-controls",
        `stalled-${action}`,
      );
      try {
        render(<CompactHistoryControls />);
        fireEvent.click(screen.getByRole("button", { name: label }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(DOCUMENT_SEND_WAIT_MS * 4);
        });
        expect(move).not.toHaveBeenCalled();
        expect(useDawStore.getState().statusAnnouncement).toBe(
          `${label} runs after save`,
        );
        noteSaveLanded(
          "/tmp/history-controls",
          HISTORY_ROOT_ID,
          documentScope(),
        );
        save.finish();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(move).toHaveBeenCalledWith("/tmp/history-controls", {
          scope: scopeAtPress,
          expectedHeadId: HISTORY_ROOT_ID,
        });
      } finally {
        save.finish();
        vi.useRealTimers();
      }
    });
  }
});
