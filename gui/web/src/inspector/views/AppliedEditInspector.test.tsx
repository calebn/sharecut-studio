import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { restoreAppliedEdit } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { appliedEditRecord, minimalProject } from "../../test/fixtures";
import { AppliedEditInspector } from "./AppliedEditInspector";

vi.mock("../../api", () => ({
  restoreAppliedEdit: vi.fn(async () => undefined),
}));

describe("AppliedEditInspector restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("restores a host edit with complete clocks and clears a removed selection", async () => {
    const user = userEvent.setup();
    useDawStore.getState().setSelection({ kind: "applied", id: "edit-1" });
    const { container } = render(
      <AppliedEditInspector rec={appliedEditRecord()} />,
    );
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(restoreAppliedEdit).toHaveBeenCalledWith("/tmp/p.json", "edit-1");
    expect(useDawStore.getState().selection).toBeNull();
  });

  it("explains missing clocks to an owner who can use History", () => {
    render(
      <AppliedEditInspector rec={appliedEditRecord({ source_start: null })} />,
    );
    expect(
      screen.queryByRole("button", { name: "Restore" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Unavailable (no source clocks). Use History undo"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/current access/)).not.toBeInTheDocument();
  });

  it.each([
    { capabilities: null },
    { capabilities: ["view"] },
    { capabilities: ["suggest"] },
    { capabilities: ["comment"] },
  ])(
    "explains limited access for a share with capabilities %j",
    async ({ capabilities }) => {
      useDawStore
        .getState()
        .hydrate("share:token", minimalProject(), "view", capabilities);
      const { container } = render(
        <AppliedEditInspector rec={appliedEditRecord()} />,
      );
      expect(
        screen.queryByRole("button", { name: "Restore" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("Restore is unavailable with your current access."),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/no source clocks|History undo/),
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
    render(<AppliedEditInspector rec={appliedEditRecord()} />);
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(restoreAppliedEdit).toHaveBeenCalledWith("share:token", "edit-1");
    expect(screen.queryByText(/current access/)).not.toBeInTheDocument();
  });

  it("reports restore failure without clearing the selection", async () => {
    vi.mocked(restoreAppliedEdit).mockRejectedValueOnce(
      new Error("Restore failed"),
    );
    useDawStore.getState().setSelection({ kind: "applied", id: "edit-1" });
    const user = userEvent.setup();
    render(<AppliedEditInspector rec={appliedEditRecord()} />);
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
