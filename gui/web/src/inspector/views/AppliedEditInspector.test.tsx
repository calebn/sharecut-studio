import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { restoreAppliedEdit } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import {
  appliedEditRecord,
  COMMENTER_CAPABILITIES,
  minimalProject,
} from "../../test/fixtures";
import { AppliedEditInspector } from "./AppliedEditInspector";

vi.mock("../../api", () => ({
  restoreAppliedEdit: vi.fn(async () => undefined),
}));

describe("AppliedEditInspector restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("restores a host mute with source clocks and clears a removed selection", async () => {
    const user = userEvent.setup();
    useDawStore.getState().setSelection({ kind: "applied", id: "edit-1" });
    const { container } = render(
      <AppliedEditInspector
        rec={appliedEditRecord({ params: { mute: true } })}
      />,
    );
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(restoreAppliedEdit).toHaveBeenCalledWith("/tmp/p.json", "edit-1");
    expect(useDawStore.getState().selection).toBeNull();
  });

  it("explains missing clocks to an owner who can use History", () => {
    render(
      <AppliedEditInspector
        rec={appliedEditRecord({ source_start: null, params: { mute: true } })}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Restore" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "This mute has no valid source clocks. Use History Undo to restore the whole action. History Undo also undoes the other edits in that action. You may need to undo later actions first.",
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
        <AppliedEditInspector
          rec={appliedEditRecord({ params: { mute: true } })}
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
      <AppliedEditInspector
        rec={appliedEditRecord({ params: { mute: true } })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(restoreAppliedEdit).toHaveBeenCalledWith("share:token", "edit-1");
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
  ])("directs a cut to whole-action History Undo for %j", async (record) => {
    const user = userEvent.setup();
    const { container } = render(
      <AppliedEditInspector rec={appliedEditRecord(record)} />,
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
    expect(useDawStore.getState().activeTab).toBe("history");
    expect(restoreAppliedEdit).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("allows a source mute without timeline clocks", async () => {
    const user = userEvent.setup();
    render(
      <AppliedEditInspector
        rec={appliedEditRecord({
          params: { mute: true },
          timeline_start: null,
          timeline_end: null,
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(restoreAppliedEdit).toHaveBeenCalledWith("/tmp/p.json", "edit-1");
    expect(useDawStore.getState().selection).toBeNull();
  });

  it("reports restore failure without clearing the selection", async () => {
    vi.mocked(restoreAppliedEdit).mockRejectedValueOnce(
      new Error("Restore failed"),
    );
    useDawStore.getState().setSelection({ kind: "applied", id: "edit-1" });
    const user = userEvent.setup();
    render(
      <AppliedEditInspector
        rec={appliedEditRecord({ params: { mute: true } })}
      />,
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
});
