import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { undoHistory } from "../api";
import { clearRegisteredCommands } from "../commands/execute";
import {
  _resetHistoryMovesForTests,
  registerHistoryCommands,
} from "../commands/history";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import type { HistoryEntryId } from "../types/project";
import { ApiError } from "../utils/apiError";
import { FeedbackToast } from "./FeedbackToast";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  undoHistory: vi.fn(async () => null),
}));

const entry = (id: string) => id as HistoryEntryId;

/** History as the tab sees it: `cursor` alone cannot tell two entries apart at the cap. */
function atHead(headId: string, cursor = 399) {
  const project = useDawStore.getState().project ?? minimalProject();
  useDawStore.setState({
    project: {
      ...project,
      history: {
        ...project.history,
        cursor,
        head_id: entry(headId),
        can_undo: true,
      },
    },
  });
}

describe("FeedbackToast", () => {
  it.each(["Time +0.01", "Level +0.01"])(
    "keeps another visible compact control clear after %s by using the flow host",
    async (action) => {
      const host = document.createElement("div");
      document.body.append(host);
      const { unmount } = render(<FeedbackToast host={host} />);
      act(() => useDawStore.getState().announceStatus(`${action} saved`));
      const message = screen.getByText(`${action} saved`);
      expect(host).toContainElement(message);
      expect(message.closest(".ui-toast-region")).toHaveClass(
        "ui-toast-region--inspector-flow",
      );
      expect(message.closest(".ui-toast-region")).not.toHaveAttribute("style");
      await expectNoA11yViolations(host);
      unmount();
      host.remove();
    },
  );

  afterEach(() => vi.useRealTimers());

  it("keeps the card, focus pause and timer across flow, stow and floating transitions", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const { rerender, unmount } = render(<FeedbackToast />);
    act(() =>
      useDawStore
        .getState()
        .announceStatus("Removed Host", { undo: entry("host-reorder") }),
    );
    const card = screen.getByText("Removed Host").closest(".ui-toast");
    const undo = screen.getByRole("button", { name: "Undo" });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    rerender(<FeedbackToast host={host} />);
    expect(screen.getByText("Removed Host").closest(".ui-toast")).toBe(card);
    act(() => undo.focus());
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(undo).toHaveFocus();
    expect(undo).toBeEnabled();
    host.remove();
    rerender(<FeedbackToast />);
    expect(screen.getByText("Removed Host").closest(".ui-toast")).toBe(card);
    expect(undo).toHaveFocus();
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByText("Removed Host")).toBeVisible();
    act(() => screen.getByRole("button", { name: "Dismiss" }).blur());
    act(() => undo.blur());
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.queryByText("Removed Host")).not.toBeInTheDocument();
    unmount();
  });

  it("does not restart an unpaused timer when the presentation changes", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    const { rerender, unmount } = render(<FeedbackToast />);
    act(() => useDawStore.getState().announceStatus("Saved"));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    rerender(<FeedbackToast host={host} />);
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(screen.getByText("Saved")).toBeVisible();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    unmount();
    host.remove();
  });

  beforeEach(() => {
    clearRegisteredCommands();
    registerHistoryCommands();
    _resetHistoryMovesForTests();
    vi.mocked(undoHistory).mockReset();
    vi.mocked(undoHistory).mockResolvedValue(null);
    useDawStore.setState({
      projectPath: "/tmp/ep",
      project: minimalProject(),
      guestMode: null,
      shareCapabilities: [],
      feedbackToast: null,
    });
    atHead("host-reorder");
  });

  it("shows each announcement, and Undo undoes exactly the entry the change recorded", async () => {
    const user = userEvent.setup();
    render(<FeedbackToast />);
    act(() => {
      useDawStore
        .getState()
        .announceStatus("Removed Host", { undo: entry("host-reorder") });
    });
    expect(screen.getByText("Removed Host")).toBeVisible();
    await expectNoA11yViolations(document.body);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(undoHistory).toHaveBeenCalledWith("/tmp/ep", {
      expectedHeadId: "host-reorder",
    });
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Undone: Removed Host",
    );
    expect(screen.getByText("Undone: Removed Host")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Undo" }),
    ).not.toBeInTheDocument();
  });

  it("drops Undo when an agent edit replaces the head at the 400-entry cap, though the cursor stays put", () => {
    render(<FeedbackToast />);
    act(() => {
      useDawStore
        .getState()
        .announceStatus("Reordered track", { undo: entry("host-reorder") });
    });
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    act(() => atHead("agent-cut", 399));
    expect(
      screen.queryByRole("button", { name: "Undo" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Reordered track")).toBeVisible();
    expect(undoHistory).not.toHaveBeenCalled();
  });

  it("says plainly that nothing was undone when an agent edit lands before the click", async () => {
    vi.mocked(undoHistory).mockRejectedValueOnce(
      new ApiError("Did not undo", "history_stale", 409),
    );
    const user = userEvent.setup();
    render(<FeedbackToast />);
    act(() => {
      useDawStore
        .getState()
        .announceStatus("Applied tighten hit", { undo: entry("host-reorder") });
    });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    const refused =
      "Can't undo: the project changed since. Nothing was undone.";
    expect(useDawStore.getState().statusAnnouncement).toBe(refused);
    expect(screen.getByText(refused)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Undo" }),
    ).not.toBeInTheDocument();
    await expectNoA11yViolations(document.body);
  });

  it("speaks a quiet status without replacing the toast", () => {
    render(<FeedbackToast />);
    act(() => {
      useDawStore.getState().announceStatus("Guest link copied");
      useDawStore
        .getState()
        .announceStatus("Pipeline: running", { toast: false });
    });
    expect(useDawStore.getState().statusAnnouncement).toBe("Pipeline: running");
    expect(screen.getByText("Guest link copied")).toBeVisible();
    expect(screen.queryByText("Pipeline: running")).not.toBeInTheDocument();
  });

  it.each(["floating", "flow"])(
    "keeps stale-head Undo guarded in %s",
    async (presentation) => {
      const host = document.createElement("div");
      document.body.append(host);
      const user = userEvent.setup();
      const { unmount } = render(
        <FeedbackToast host={presentation === "flow" ? host : null} />,
      );
      act(() =>
        useDawStore
          .getState()
          .announceStatus("Removed Host", { undo: entry("host-reorder") }),
      );
      act(() => atHead("agent-cut"));
      expect(
        screen.queryByRole("button", { name: "Undo" }),
      ).not.toBeInTheDocument();
      expect(undoHistory).not.toHaveBeenCalled();
      act(() =>
        useDawStore
          .getState()
          .announceStatus("Applied hit", { undo: entry("agent-cut") }),
      );
      vi.mocked(undoHistory).mockRejectedValueOnce(
        new ApiError("Did not undo", "history_stale", 409),
      );
      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(undoHistory).toHaveBeenCalledWith("/tmp/ep", {
        expectedHeadId: "agent-cut",
      });
      expect(
        screen.getByText(
          "Can't undo: the project changed since. Nothing was undone.",
        ),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Undo" }),
      ).not.toBeInTheDocument();
      unmount();
      host.remove();
    },
  );

  it("closes on Dismiss", async () => {
    const user = userEvent.setup();
    render(<FeedbackToast />);
    act(() => {
      useDawStore.getState().announceStatus("Mix preview refreshed");
    });
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(useDawStore.getState().feedbackToast).toBeNull();
    expect(screen.queryByText("Mix preview refreshed")).not.toBeInTheDocument();
  });
});
