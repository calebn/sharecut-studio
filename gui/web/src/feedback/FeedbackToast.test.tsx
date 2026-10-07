import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { undoHistory } from "../api";
import { clearRegisteredCommands } from "../commands/execute";
import { registerHistoryCommands } from "../commands/history";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import type { HistoryEntryId } from "../types/project";
import { ApiError } from "../utils/apiError";
import { FeedbackToast } from "./FeedbackToast";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  undoHistory: vi.fn(async () => undefined),
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
  beforeEach(() => {
    clearRegisteredCommands();
    registerHistoryCommands();
    vi.mocked(undoHistory).mockReset();
    vi.mocked(undoHistory).mockResolvedValue(undefined);
    useDawStore.setState({
      projectPath: "/tmp/ep",
      project: minimalProject(),
      feedbackToast: null,
    });
    atHead("host-reorder");
  });

  it("shows each announcement, and Undo undoes exactly the entry the change recorded", async () => {
    const user = userEvent.setup();
    const { container } = render(<FeedbackToast />);
    act(() => {
      useDawStore
        .getState()
        .announceStatus("Removed Host", { undo: entry("host-reorder") });
    });
    expect(screen.getByText("Removed Host")).toBeVisible();
    await expectNoA11yViolations(container);
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
    const { container } = render(<FeedbackToast />);
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
    await expectNoA11yViolations(container);
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
