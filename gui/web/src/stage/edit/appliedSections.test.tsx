import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreAppliedEdit } from "../../api";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { refreshDocumentProject } from "../../document/applyDocumentUpdate";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import {
  appliedEditRecord,
  COMMENTER_CAPABILITIES,
  minimalProject,
} from "../../test/fixtures";
import { AppliedEdit } from "./AppliedEdit";
import { SectionsBody } from "./SectionsBody";

vi.mock("../../document/applyDocumentUpdate", () => ({
  refreshDocumentProject: vi.fn(async () => ({})),
}));
vi.mock("../../api", () => ({
  restoreAppliedEdit: vi.fn(async () => undefined),
}));

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
});

afterEach(() => {
  clearRegisteredCommands();
});

describe("applied edit sheet content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("restores a ready record and clears a removed selection", async () => {
    const user = userEvent.setup();
    useDawStore.getState().setSelection({ kind: "applied", id: "edit-1" });
    const { container } = render(
      <AppliedEdit rec={appliedEditRecord({ restore: { state: "ready" } })} />,
    );
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(restoreAppliedEdit).toHaveBeenCalledWith("/tmp/p.json", ["edit-1"]);
    expect(useDawStore.getState().selection).toBeNull();
  });

  it("explains a blocked restore to an owner who can use History", () => {
    render(
      <AppliedEdit
        rec={appliedEditRecord({
          restore: {
            state: "blocked",
            code: "track_missing",
            message: "Track mira-voice is no longer in the project.",
            blocked_by: [],
          },
        })}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Restore" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Track mira-voice is no longer in the project. Use History Undo to restore the whole action. History Undo also undoes the other edits in that action. You may need to undo later actions first.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/current access/)).not.toBeInTheDocument();
  });

  it.each([
    { capabilities: null },
    { capabilities: ["view"] },
    { capabilities: COMMENTER_CAPABILITIES },
  ])(
    "explains limited access for a share with capabilities %j",
    async ({ capabilities }) => {
      useDawStore
        .getState()
        .hydrate("share:token", minimalProject(), "view", capabilities);
      const { container } = render(
        <AppliedEdit
          rec={appliedEditRecord({ restore: { state: "ready" } })}
        />,
      );
      expect(
        screen.queryByRole("button", { name: "Restore" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("Restore is unavailable with your current access."),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/no valid source clocks|History Undo/),
      ).not.toBeInTheDocument();
      expect(restoreAppliedEdit).not.toHaveBeenCalled();
      await expectNoA11yViolations(container);
    },
  );

  it("allows restore on a share explicitly granted edit", async () => {
    useDawStore
      .getState()
      .hydrate("share:token", minimalProject(), "view", ["edit"]);
    const user = userEvent.setup();
    render(
      <AppliedEdit rec={appliedEditRecord({ restore: { state: "ready" } })} />,
    );
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(restoreAppliedEdit).toHaveBeenCalledWith("share:token", ["edit-1"]);
    expect(screen.queryByText(/current access/)).not.toBeInTheDocument();
  });

  it.each([
    { operation: "approve_edits", params: {} },
    { operation: "ripple_delete", params: {} },
    { operation: "punch_delete", params: { scope: "track" } },
    {
      operation: "edit_selected_range",
      params: { exact_range: {}, mute: true },
    },
  ])("directs a history-only record to History Undo for %j", async (record) => {
    const user = userEvent.setup();
    const { container } = render(
      <AppliedEdit rec={appliedEditRecord(record)} />,
    );
    expect(
      screen.queryByRole("button", { name: "Restore" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "This edit cannot be restored individually. Use History Undo to restore the whole action. History Undo also undoes the other edits in that action. You may need to undo later actions first.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open History" }));
    expect(useDawStore.getState().stage).toBe("edit");
    expect(useDawStore.getState().openSheet).toBe("history");
    expect(restoreAppliedEdit).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("restores a ready record without timeline clocks", async () => {
    const user = userEvent.setup();
    render(
      <AppliedEdit
        rec={appliedEditRecord({
          restore: { state: "ready" },
          timeline_start: null,
          timeline_end: null,
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(restoreAppliedEdit).toHaveBeenCalledWith("/tmp/p.json", ["edit-1"]);
    expect(useDawStore.getState().selection).toBeNull();
  });

  it("reports restore failure without clearing the selection", async () => {
    vi.mocked(restoreAppliedEdit).mockRejectedValueOnce(
      new Error("Restore failed"),
    );
    useDawStore.getState().setSelection({ kind: "applied", id: "edit-1" });
    const user = userEvent.setup();
    render(
      <AppliedEdit rec={appliedEditRecord({ restore: { state: "ready" } })} />,
    );
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Restore failed",
    );
    expect(useDawStore.getState().selection).toEqual({
      kind: "applied",
      id: "edit-1",
    });
  });

  it("re-reads the project after a restore conflict so a stale ready button does not stay", async () => {
    vi.mocked(restoreAppliedEdit).mockRejectedValueOnce(new Error("Blocked."));
    const user = userEvent.setup();
    render(
      <AppliedEdit rec={appliedEditRecord({ restore: { state: "ready" } })} />,
    );
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Blocked.");
    expect(refreshDocumentProject).toHaveBeenCalledWith("/tmp/p.json");
  });

  it("builds the sheet content for the selected record and says when it is gone", () => {
    const project = minimalProject();
    project.applied_edits.records = [
      appliedEditRecord({ restore: { state: "ready" } }),
    ];
    useDawStore.getState().hydrate("/tmp/p.json", project);
    useDawStore.getState().setSelection({ kind: "applied", id: "edit-1" });
    const { unmount } = render(<SectionsBody withRange={false} />);
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    unmount();
    useDawStore.getState().setSelection({ kind: "applied", id: "gone" });
    render(<SectionsBody withRange={false} />);
    expect(screen.getByText("Record not found")).toBeInTheDocument();
  });
});
