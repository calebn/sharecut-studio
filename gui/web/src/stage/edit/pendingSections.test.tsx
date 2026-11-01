import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import {
  minimalProject,
  pendingEditView,
  sampleComment,
} from "../../test/fixtures";
import type { Selection } from "../../types/project";
import { SectionsBody } from "./SectionsBody";
import { useSelectionSections } from "./selectionSections";

vi.mock("../../api", () => ({
  approveEdits: vi.fn(),
  rejectEdits: vi.fn(),
  updatePendingEdit: vi.fn(),
  createComment: vi.fn(),
}));

const edit = pendingEditView({ id: "edit-1", suggested_action: "cut" });

function Bar() {
  const sections = useSelectionSections(
    useDawStore.getState().selection,
    false,
    true,
  );
  return (
    <>
      {sections?.flatMap((section) => section.rows.map((row) => row.control))}
    </>
  );
}

function open(selection: NonNullable<Selection>, barShown = false) {
  useDawStore.getState().hydrate(
    "/tmp/p.json",
    minimalProject({
      pending_edits: [edit],
      comments: [sampleComment({ id: "c-1", edit_decision_id: "edit-1" })],
    }),
  );
  useDawStore.getState().setSelection(selection);
  return barShown
    ? render(<Bar />)
    : render(<SectionsBody withRange={false} />);
}

describe("usePendingSections", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
  });
  afterEach(() => {
    clearRegisteredCommands();
    useDawStore.getState().setSelection(null);
  });

  it("renders the pending edit for a pending selection", () => {
    open({ kind: "pending", id: "edit-1", trackId: edit.track_id });
    expect(
      screen.getByRole("spinbutton", { name: "Source start" }),
    ).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "Source end" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("drops Approve and Reject only where the Action bar is shown", () => {
    open({ kind: "pending", id: "edit-1", trackId: edit.track_id }, true);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("renders the linked pending edit for a comment on it", () => {
    open({ kind: "comment", id: "c-1" });
    expect(
      screen.getByRole("spinbutton", { name: "Source start" }),
    ).toBeTruthy();
  });

  it("says when the edit is gone", () => {
    open({ kind: "pending", id: "missing", trackId: edit.track_id });
    expect(screen.getByText("Edit not found")).toBeTruthy();
  });
});
