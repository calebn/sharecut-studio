import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands, registerCommand } from "../commands/execute";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { FeedbackToast } from "./FeedbackToast";
import { historyCursor, historyUndoSince } from "./historyUndo";

function atHistory(cursor: number) {
  const project = useDawStore.getState().project ?? minimalProject();
  useDawStore.setState({
    project: {
      ...project,
      history: { ...project.history, cursor, can_undo: cursor > 0 },
    },
  });
}

describe("FeedbackToast", () => {
  const undo = vi.fn(async () => ({ status: "ok" as const }));

  beforeEach(() => {
    clearRegisteredCommands();
    registerCommand("history.undo", undo);
    undo.mockClear();
    useDawStore.setState({
      projectPath: "/tmp/ep",
      project: minimalProject(),
      feedbackToast: null,
    });
    atHistory(1);
  });

  it("shows each announcement, and Undo runs history.undo while history sits on the change", async () => {
    const user = userEvent.setup();
    const { container } = render(<FeedbackToast />);
    act(() => {
      useDawStore
        .getState()
        .announceStatus("Removed Host", { undo: { cursor: 1 } });
    });
    expect(screen.getByText("Removed Host")).toBeVisible();
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledOnce();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Undone: Removed Host",
    );
    expect(screen.getByText("Undone: Removed Host")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Undo" }),
    ).not.toBeInTheDocument();
  });

  it("drops Undo for good once anything else moves history", () => {
    render(<FeedbackToast />);
    act(() => {
      useDawStore
        .getState()
        .announceStatus("Reordered track", { undo: { cursor: 1 } });
    });
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    act(() => atHistory(2));
    expect(
      screen.queryByRole("button", { name: "Undo" }),
    ).not.toBeInTheDocument();
    act(() => atHistory(1));
    expect(
      screen.queryByRole("button", { name: "Undo" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Reordered track")).toBeVisible();
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

describe("historyUndoSince", () => {
  beforeEach(() => {
    useDawStore.setState({ project: minimalProject() });
  });

  it("offers Undo only when the change moved history forward", () => {
    atHistory(3);
    const before = historyCursor();
    expect(before).toBe(3);
    expect(historyUndoSince(before)).toBeNull();
    atHistory(4);
    expect(historyUndoSince(before)).toEqual({ cursor: 4 });
    expect(historyUndoSince(null)).toBeNull();
  });
});
