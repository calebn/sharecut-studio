import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands, execute } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import {
  minimalProject,
  pendingEditView,
  sampleComment,
} from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { CommentPopover } from "./CommentPopover";
import { EditWorkspace } from "./EditWorkspace";

const patchComment = vi.fn();
const addCommentReply = vi.fn();

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  patchComment: (...args: unknown[]) => patchComment(...args),
  addCommentReply: (...args: unknown[]) => addCommentReply(...args),
}));

type Hydrate = [string, ...unknown[]];

function openComment(
  comment = sampleComment(),
  hydrateArgs: Hydrate = ["/tmp/p.json"],
  extra: Parameters<typeof minimalProject>[0] = {},
) {
  const [path, mode, caps] = hydrateArgs as [string, never, never];
  useDawStore
    .getState()
    .hydrate(
      path,
      minimalProject({ comments: [comment], ...extra }),
      mode,
      caps,
    );
  useDawStore.setState({
    stage: "edit",
    openSheet: null,
    selection: { kind: "comment", id: comment.id },
    inspectorKey: null,
    rangeArmed: false,
  });
}

const inspect = () =>
  act(async () => {
    await execute("edit.inspect", {}, { skipWhen: true });
  });

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  patchComment.mockReset().mockResolvedValue(null);
  addCommentReply.mockReset().mockResolvedValue(null);
  vi.stubGlobal("IntersectionObserver", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearRegisteredCommands();
  useDawStore.getState().setSelection(null);
});

describe("the comment popover on the desktop and the tablet", () => {
  it.each(["desktop", "tablet"] as const)(
    "opens the thread on Inspect on the %s shell, in place of the Inspector card",
    async (shell) => {
      stubViewportShell(shell);
      openComment(
        sampleComment({
          replies: [{ id: "r1", author: "ana", body: "On it" } as never],
        }),
      );
      render(<EditWorkspace />);
      expect(screen.queryByRole("dialog", { name: "Comment" })).toBeNull();
      await inspect();
      const popover = screen.getByRole("dialog", { name: "Comment" });
      expect(screen.queryByRole("dialog", { name: "Inspector" })).toBeNull();
      expect(within(popover).getByText("Needs a tighter open")).toBeVisible();
      expect(within(popover).getByText("On it")).toBeVisible();
      expect(
        within(popover).getByRole("textbox", { name: "Reply to caleb" }),
      ).toBeVisible();
      expect(within(popover).queryByText("Tracks")).toBeNull();
      await expectNoA11yViolations(popover);
    },
  );

  it("offers no Resolve on an open comment: the Action bar owns it", async () => {
    stubViewportShell("desktop");
    openComment();
    render(<EditWorkspace />);
    await inspect();
    const popover = screen.getByRole("dialog", { name: "Comment" });
    expect(
      within(popover).queryByRole("button", { name: "Resolve" }),
    ).toBeNull();
    expect(
      within(popover).queryByRole("button", { name: "Reopen" }),
    ).toBeNull();
  });

  it("reopens a resolved comment from the popover", async () => {
    stubViewportShell("desktop");
    openComment(sampleComment({ resolved: true, resolved_by: "Mira" }));
    render(<EditWorkspace />);
    await inspect();
    const popover = screen.getByRole("dialog", { name: "Comment" });
    expect(within(popover).getByText("Resolved by Mira")).toBeVisible();
    await userEvent.click(
      within(popover).getByRole("button", { name: "Reopen" }),
    );
    expect(patchComment).toHaveBeenCalledWith(
      "/tmp/p.json",
      "c1",
      expect.objectContaining({ resolved: false }),
    );
  });

  it("keeps Reopen from a share link and Reply from a link without reply permission", async () => {
    stubViewportShell("desktop");
    openComment(sampleComment({ resolved: true, resolved_by: "Mira" }), [
      "share:token",
      "view",
      ["view"],
    ]);
    render(<EditWorkspace />);
    await inspect();
    const popover = screen.getByRole("dialog", { name: "Comment" });
    expect(
      within(popover).queryByRole("button", { name: "Reopen" }),
    ).toBeNull();
    expect(within(popover).queryByRole("textbox")).toBeNull();
  });

  it("lets a commenter link reply but never reopen", async () => {
    stubViewportShell("desktop");
    openComment(sampleComment({ resolved: true }), [
      "share:token",
      "comment",
      ["comment"],
    ]);
    render(<EditWorkspace />);
    await inspect();
    const popover = screen.getByRole("dialog", { name: "Comment" });
    expect(
      within(popover).getByRole("textbox", { name: "Reply to caleb" }),
    ).toBeVisible();
    expect(
      within(popover).queryByRole("button", { name: "Reopen" }),
    ).toBeNull();
  });

  it("sends a reply on Enter", async () => {
    stubViewportShell("desktop");
    openComment();
    render(<EditWorkspace />);
    await inspect();
    const field = screen.getByRole("textbox", { name: "Reply to caleb" });
    await userEvent.type(field, "Keep this{Enter}");
    expect(addCommentReply).toHaveBeenCalledWith("/tmp/p.json", "c1", {
      body: "Keep this",
      author: expect.any(String),
    });
  });

  it("closes on Escape and returns focus to the opener", async () => {
    stubViewportShell("desktop");
    openComment();
    const from = document.createElement("button");
    from.textContent = "Opener";
    document.body.append(from);
    from.focus();
    render(<EditWorkspace />);
    await inspect();
    const popover = screen.getByRole("dialog", { name: "Comment" });
    expect(popover).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Comment" })).toBeNull();
    expect(useDawStore.getState().inspectorKey).toBeNull();
    expect(from).toHaveFocus();
    from.remove();
  });

  it("closes from its Close button", async () => {
    stubViewportShell("desktop");
    openComment();
    render(<EditWorkspace />);
    await inspect();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Comment" })).toBeNull();
  });

  it("leaves a comment on a pending edit to the Suggestion card", async () => {
    stubViewportShell("desktop");
    openComment(sampleComment({ edit_decision_id: "pe1" }), ["/tmp/p.json"], {
      pending_edits: [pendingEditView({ id: "pe1" })],
    });
    render(<EditWorkspace />);
    await inspect();
    expect(screen.queryByRole("dialog", { name: "Comment" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Inspector" })).toBeVisible();
  });
});

describe("the comment sheet on the phone", () => {
  it("keeps the thread, Reply included, in the bottom sheet", async () => {
    stubViewportShell("phone");
    openComment();
    render(<EditWorkspace />);
    await inspect();
    const sheet = screen.getByRole("dialog", { name: "Inspector" });
    expect(within(sheet).getByText("Needs a tighter open")).toBeVisible();
    expect(
      within(sheet).getByRole("textbox", { name: "Reply to caleb" }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Comment" })).toBeNull();
  });

  it("shows Reopen on a resolved comment and not to a share link", async () => {
    stubViewportShell("phone");
    openComment(sampleComment({ resolved: true }));
    const { unmount } = render(<EditWorkspace />);
    await inspect();
    expect(screen.getByRole("button", { name: "Reopen" })).toBeVisible();
    unmount();
    openComment(sampleComment({ resolved: true }), [
      "share:token",
      "comment",
      ["comment"],
    ]);
    render(<EditWorkspace />);
    await inspect();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Reply to caleb" }),
    ).toBeVisible();
  });
});

describe("the comment popover placement", () => {
  function place(clearTop: number) {
    openComment();
    const pin = document.createElement("div");
    pin.getBoundingClientRect = () => new DOMRect(300, 10, 16, 16);
    document.body.append(pin);
    const panelRef = { current: null as HTMLDivElement | null };
    render(
      <CommentPopover
        commentId="c1"
        anchor={{
          ref: { current: pin },
          moves: [],
          clearTop: () => clearTop,
        }}
        root={null}
        panelRef={panelRef}
        onClose={vi.fn()}
      />,
    );
    pin.remove();
    return screen.getByLabelText("Comment", { selector: "section" });
  }

  it("hides while the chrome above the lanes would cover it, as the Action bar does", () => {
    expect(place(400).style.visibility).toBe("hidden");
  });

  it("shows beside the pin when nothing covers it", () => {
    const popover = place(0);
    expect(popover.style.visibility).toBe("");
    expect(popover.style.top).not.toBe("");
  });
});
