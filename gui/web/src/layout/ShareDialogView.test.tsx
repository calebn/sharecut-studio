import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { hostShareRow } from "../test/fixtures";
import { SRC_ROOT } from "../test/sourceFiles";
import { ShareDialogView } from "./ShareDialogView";
import { shareCopyKey } from "./shareCopyKey";

const reviewRow = hostShareRow();
const agentRow = hostShareRow({
  token: "sample-agent-link",
  url: "http://127.0.0.1:8765/r/sample-agent-link",
  docs_role: "editor",
  mcp_url: "http://127.0.0.1:8765/r/sample-agent-link/mcp",
  review_version_label: null,
});
const revokedRow = hostShareRow({
  token: "sample-stale-link",
  usable: false,
});
const guestRow = hostShareRow({
  token: "sample-guest-link",
  url: "http://127.0.0.1:8765/r/sample-guest-link",
  kind: "record",
  docs_role: null,
  record_role: "guest",
  session_id: "sample-room",
});
const producerRow = hostShareRow({
  token: "sample-producer-link",
  url: "http://127.0.0.1:8765/r/sample-producer-link",
  kind: "record",
  docs_role: null,
  record_role: "producer",
  session_id: "sample-room",
});

function baseProps(): Parameters<typeof ShareDialogView>[0] {
  return {
    open: true,
    onClose: vi.fn(),
    role: "commenter",
    onRoleChange: vi.fn(),
    withMcp: false,
    onWithMcpChange: vi.fn(),
    rows: [reviewRow, agentRow, guestRow, producerRow, revokedRow],
    busy: false,
    createRecovery: { kind: "idle" },
    error: null,
    status: null,
    copiedKey: null,
    lastCreated: null,
    onCreate: vi.fn(),
    onRefreshMix: vi.fn(),
    onCreateRecord: vi.fn(),
    onCopy: vi.fn(),
    onRevoke: vi.fn(),
    onEndRoom: vi.fn(),
    onReplaceRecordInvite: vi.fn(),
    onOpenRoomPanel: vi.fn(),
  };
}

/** The Dialog moves focus to Close one frame after it opens. */
async function dialogSettled() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus(),
  );
}

describe("ShareDialogView", () => {
  it("names review links by role, keeps the slug as their address; axe-clean", async () => {
    const props = baseProps();
    props.rows = [
      hostShareRow({
        created_at: "2026-10-01T12:00:00Z",
        last_used_at: "2026-10-01T12:00:00Z",
      }),
      agentRow,
      guestRow,
      producerRow,
      revokedRow,
    ];
    const { baseElement: container } = render(<ShareDialogView {...props} />);
    const rows = within(
      screen.getByRole("region", { name: "Review links" }),
    ).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(
        /^Commenter linkShare mix · Created .+sample-review-link/,
      ),
      "Editor linkAI assistants allowedsample-agent-linkCopy linkCopy MCP URLStop sharing",
    ]);
    expect(rows[0]).not.toHaveTextContent("Last opened");
    expect(screen.queryByText("sample-stale-link")).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Copy link" })[0],
    ).toHaveAccessibleDescription("Commenter link");
    expect(
      screen.getByText("Links don't expire. Stop sharing turns one off."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "A guest link records the person who joins. A producer link lets your producer listen and comment without being recorded. Record links don't expire. End room turns them off.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/expiry/)).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("shows when a link was last opened and a host-chosen expiry", () => {
    const props = baseProps();
    props.rows = [
      hostShareRow({
        created_at: "2026-10-01T12:00:00Z",
        last_used_at: "2026-10-03T12:00:00Z",
        expires_at: "2026-12-01T12:00:00Z",
      }),
    ];
    render(<ShareDialogView {...props} />);
    const meta = screen.getByText(/^Share mix · Created/);
    expect(meta).toHaveTextContent(/Last opened .+ · Expires /);
  });

  it("tells the host whether guests can reach their links; axe-clean", async () => {
    const props = baseProps();
    props.tunnel = {
      state: "reconnecting",
      reason: "network: connection lost",
      reason_kind: "network",
      relay_host: "relay.example.test",
      public_base_url: "https://share.example.test",
      share_count: 2,
      retry_at: null,
    };
    const { baseElement: container } = render(<ShareDialogView {...props} />);
    const note = screen.getByRole("status");
    expect(note).toHaveTextContent(
      "Reconnecting… guests may see a brief interruption",
    );
    expect(note.textContent).not.toContain("connection lost");
    await expectNoA11yViolations(container);
  });

  it("shows no online sharing line when unavailable or for a local-only host", () => {
    const props = baseProps();
    props.tunnel = null;
    const { rerender } = render(<ShareDialogView {...props} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    props.tunnel = {
      state: "not_set_up",
      reason: "online sharing is not set up",
      reason_kind: null,
      relay_host: null,
      public_base_url: null,
      share_count: null,
      retry_at: null,
    };
    rerender(<ShareDialogView {...props} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
  });

  it("discloses what Allow AI assistants (MCP) grants, next to it; axe-clean", async () => {
    const props = baseProps();
    const { baseElement: container } = render(<ShareDialogView {...props} />);
    const mcp = screen.getByRole("checkbox", {
      name: "Allow AI assistants (MCP)",
    });
    expect(mcp).not.toBeChecked();
    expect(mcp).toHaveAccessibleDescription(
      "Paste into an MCP client such as Claude or ChatGPT. The assistant gets this link's permissions.",
    );
    await expectNoA11yViolations(container);
  });

  it("offers each review-link role with what it can do; axe-clean", async () => {
    const props = baseProps();
    const { baseElement: container } = render(<ShareDialogView {...props} />);
    const roles = screen.getByRole("group", {
      name: "Anyone with the link",
    });
    const offered = within(roles)
      .getAllByRole("radio")
      .map((radio) => [
        radio.getAttribute("value"),
        (radio as HTMLInputElement).checked,
      ]);
    expect(offered).toEqual([
      ["viewer", false],
      ["commenter", true],
      ["editor", false],
    ]);
    expect(
      screen.getByRole("radio", { name: "Viewer" }),
    ).toHaveAccessibleDescription("Views and plays the project.");
    expect(
      screen.getByRole("radio", { name: "Commenter" }),
    ).toHaveAccessibleDescription(
      "Also comments and suggests edits for you or an Editor to approve.",
    );
    expect(
      screen.getByRole("radio", { name: "Editor" }),
    ).toHaveAccessibleDescription(
      "Also edits directly and approves or rejects suggestions.",
    );
    expect(
      screen.getByText(
        "Everyone with the link sees your cursor, selection, playhead, and viewport while they are in the session.",
      ),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("shows empty states; axe-clean", async () => {
    const props = baseProps();
    props.rows = [];
    const { baseElement: container } = render(<ShareDialogView {...props} />);
    expect(screen.getByText("No review links yet.")).toBeInTheDocument();
    expect(screen.getByText("No record rooms yet.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create record links" }),
    ).toBeEnabled();
    await expectNoA11yViolations(container);
  });

  it("shows a typed stale-mix recovery action; axe-clean", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    props.createRecovery = {
      kind: "stale_mix",
      message: "The preview is out of date.",
      refreshError: null,
    };
    const { baseElement: container } = render(<ShareDialogView {...props} />);
    expect(screen.getByText("The preview is out of date.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh mix" }));
    expect(props.onRefreshMix).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("reports every control through its callback", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<ShareDialogView {...props} />);

    await user.click(screen.getByRole("radio", { name: "Editor" }));
    expect(props.onRoleChange).toHaveBeenCalledWith("editor");

    await user.click(screen.getByLabelText("Allow AI assistants (MCP)"));
    expect(props.onWithMcpChange).toHaveBeenCalledWith(true);

    await user.click(
      screen.getByRole("button", { name: "Create review link" }),
    );
    expect(props.onCreate).toHaveBeenCalledOnce();

    await user.click(
      screen.getByRole("button", { name: "Create record links" }),
    );
    expect(props.onCreateRecord).toHaveBeenCalledOnce();

    await user.click(screen.getAllByRole("button", { name: "Copy link" })[0]);
    expect(props.onCopy).toHaveBeenCalledWith(
      "link",
      "sample-review-link",
      "Link",
      reviewRow.url,
    );

    await user.click(screen.getByRole("button", { name: "Copy MCP URL" }));
    expect(props.onCopy).toHaveBeenCalledWith(
      "mcp",
      "sample-agent-link",
      "MCP URL",
      agentRow.mcp_url,
    );

    await user.click(screen.getByRole("button", { name: "Copy guest link" }));
    expect(props.onCopy).toHaveBeenCalledWith(
      "link",
      "sample-guest-link",
      "Guest link",
      guestRow.url,
    );

    await user.click(screen.getByRole("button", { name: "Open room panel" }));
    expect(props.onOpenRoomPanel).toHaveBeenCalledOnce();
  });

  it("confirms Stop sharing in place, naming the link and the consequence; axe-clean", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    const { baseElement: container } = render(<ShareDialogView {...props} />);
    await dialogSettled();
    const stop = () =>
      within(
        screen.getByText("Commenter link").closest("li") as HTMLElement,
      ).getByRole("button", { name: "Stop sharing" });

    await user.click(stop());
    const confirm = screen.getByRole("group", {
      name: "Stop sharing this Commenter link? Anyone using it loses access.",
    });
    expect(
      within(confirm)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Keep link", "Stop sharing"]);
    expect(
      within(confirm).getByRole("button", { name: "Keep link" }),
    ).toHaveFocus();
    expect(props.onRevoke).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);

    await user.click(screen.getByRole("button", { name: "Keep link" }));
    expect(screen.queryByRole("group", { name: /^Stop sharing/ })).toBeNull();
    expect(stop()).toHaveFocus();
    expect(props.onRevoke).not.toHaveBeenCalled();

    await user.click(stop());
    await user.click(
      within(
        screen.getByRole("group", { name: /^Stop sharing this Commenter/ }),
      ).getByRole("button", { name: "Stop sharing" }),
    );
    expect(props.onRevoke).toHaveBeenCalledExactlyOnceWith(
      "sample-review-link",
    );
    expect(screen.getByRole("heading", { name: "Review links" })).toHaveFocus();
  });

  it("cancels an open Stop sharing confirm on Escape before closing the dialog", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<ShareDialogView {...props} />);
    await dialogSettled();
    const stop = () =>
      within(
        screen.getByText("Commenter link").closest("li") as HTMLElement,
      ).getByRole("button", { name: "Stop sharing" });

    await user.click(stop());
    expect(
      screen.getByRole("group", { name: /^Stop sharing this Commenter/ }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: /^Stop sharing/ })).toBeNull();
    expect(stop()).toHaveFocus();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onRevoke).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("puts room actions in one room row, End room last and confirmed; axe-clean", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    const { baseElement: container } = render(<ShareDialogView {...props} />);
    await dialogSettled();
    const room = screen.getByText("Record room").closest("li") as HTMLElement;
    const endRoom = within(room).getByRole("button", { name: "End room" });
    expect(endRoom.closest(".share-dialog-link")).toBeNull();
    expect(
      [...(endRoom.parentElement?.children ?? [])].map((b) => b.textContent),
    ).toEqual(["Open room panel", "End room"]);

    await user.click(endRoom);
    const confirm = screen.getByRole("group", {
      name: "End this record room? Both guest and producer links will stop working.",
    });
    expect(
      within(confirm).getByRole("button", { name: "Keep room" }),
    ).toHaveFocus();
    await expectNoA11yViolations(container);
    expect(props.onEndRoom).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "End room" }));
    expect(props.onEndRoom).toHaveBeenCalledExactlyOnceWith("sample-room");
  });

  it("pins Create review link and the last created link's copy to the footer", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    props.lastCreated = {
      token: "sample-review-link",
      url: "http://127.0.0.1:8765/r/sample-review-link",
      kind: "review",
    };
    props.status = "Review link created and copied";
    const { rerender } = render(<ShareDialogView {...props} />);
    const footer = document.querySelector(
      ".command-palette-footer",
    ) as HTMLElement;
    expect(
      within(footer)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Copy link", "Create review link"]);
    expect(footer).toHaveTextContent("Review link created and copied");
    await user.click(within(footer).getByRole("button", { name: "Copy link" }));
    expect(props.onCopy).toHaveBeenCalledWith(
      "link",
      "sample-review-link",
      "Link",
      "http://127.0.0.1:8765/r/sample-review-link",
    );

    rerender(
      <ShareDialogView
        {...props}
        lastCreated={{ token: "sample-guest-link", url: "u", kind: "guest" }}
      />,
    );
    expect(
      within(footer).getByRole("button", { name: "Copy guest link" }),
    ).toBeInTheDocument();

    rerender(
      <ShareDialogView
        {...props}
        lastCreated={{ token: "sample-stale-link", url: "u", kind: "review" }}
      />,
    );
    expect(
      within(footer)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Create review link"]);
  });

  it("shows copied labels", () => {
    const props = baseProps();
    props.copiedKey = shareCopyKey("link", "sample-review-link");
    render(<ShareDialogView {...props} />);
    expect(screen.getAllByRole("button", { name: "Copied link" })).toHaveLength(
      1,
    );

    props.copiedKey = shareCopyKey("link", "sample-guest-link");
    const { unmount } = render(<ShareDialogView {...props} />);
    expect(
      screen.getByRole("button", { name: "Copied guest link" }),
    ).toBeInTheDocument();
    unmount();
  });

  it("marks a closed record invite and offers source-bound replacement", async () => {
    const user = userEvent.setup();
    const closedGuest = hostShareRow({
      token: "closed-guest",
      kind: "record",
      record_role: "guest",
      session_id: "sample-room",
      invite_closed: true,
    });
    const closedProducer = hostShareRow({
      token: "closed-producer",
      kind: "record",
      record_role: "producer",
      session_id: "sample-room",
      invite_closed: true,
    });
    const props = baseProps();
    props.rows = [closedGuest, closedProducer];
    render(<ShareDialogView {...props} />);
    expect(
      screen.getByText("Guest invite closed to new guests"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy guest link" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Replace guest invite" }),
    );
    expect(props.onReplaceRecordInvite).toHaveBeenCalledWith("closed-guest");
    expect(
      screen.getByRole("button", { name: "Copy producer link" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Replace producer invite" }),
    );
    expect(props.onReplaceRecordInvite).toHaveBeenCalledWith("closed-producer");
  });

  it("disables every action while busy", () => {
    const props = baseProps();
    props.busy = true;
    render(<ShareDialogView {...props} />);
    for (const button of screen.getAllByRole("button")) {
      if (button.getAttribute("aria-label")?.startsWith("Close")) {
        continue;
      }
      expect(button).toBeDisabled();
    }
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
    expect(screen.getByLabelText("Allow AI assistants (MCP)")).toBeDisabled();
  });

  it("shows a missing producer link as disabled", () => {
    const props = baseProps();
    props.rows = [guestRow];
    render(<ShareDialogView {...props} />);
    expect(
      screen.getByText("Missing. End this room and create new record links."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy producer link" }),
    ).toBeDisabled();
  });

  it("shows error over status in the live region", () => {
    const props = baseProps();
    props.error = "Clipboard unavailable";
    props.status = "Link copied";
    const { rerender } = render(<ShareDialogView {...props} />);
    const footer = document.querySelector(
      ".command-palette-footer",
    ) as HTMLElement;
    expect(
      within(footer).getByText("Clipboard unavailable"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Link copied")).not.toBeInTheDocument();

    const okProps = { ...props, error: null };
    rerender(<ShareDialogView {...okProps} />);
    expect(screen.getByText("Link copied")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    const props = baseProps();
    props.open = false;
    render(<ShareDialogView {...props} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("has no import on store, api or command modules", () => {
    const source = readFileSync(
      join(SRC_ROOT, "layout/ShareDialogView.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/from "\.\.\/(api|state|commands)\b/);
    expect(source).not.toMatch(/useDaw/);
  });
});
