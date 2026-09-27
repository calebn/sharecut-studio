import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
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
    error: null,
    status: null,
    copiedKey: null,
    onCreate: vi.fn(),
    onCreateRecord: vi.fn(),
    onCopy: vi.fn(),
    onRevoke: vi.fn(),
    onEndRoom: vi.fn(),
    onOpenRoomPanel: vi.fn(),
  };
}

describe("ShareDialogView", () => {
  it("lists usable review links and record rooms; axe-clean", async () => {
    const props = baseProps();
    const { container } = render(<ShareDialogView {...props} />);
    expect(screen.getByText("sample-review-link")).toBeInTheDocument();
    expect(screen.getByText("sample-agent-link")).toBeInTheDocument();
    expect(screen.queryByText("sample-stale-link")).not.toBeInTheDocument();
    expect(screen.getByText("Guest link")).toBeInTheDocument();
    expect(screen.getByText("Producer link")).toBeInTheDocument();
    expect(screen.getByText(/Commenter · Share mix/)).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("shows empty states; axe-clean", async () => {
    const props = baseProps();
    props.rows = [];
    const { container } = render(<ShareDialogView {...props} />);
    expect(screen.getByText("No live review links.")).toBeInTheDocument();
    expect(screen.getByText("No live record rooms.")).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("reports every control through its callback", async () => {
    const user = userEvent.setup();
    const props = baseProps();
    render(<ShareDialogView {...props} />);

    await user.selectOptions(
      screen.getByLabelText("Anyone with the link"),
      "editor",
    );
    expect(props.onRoleChange).toHaveBeenCalledWith("editor");

    await user.click(screen.getByLabelText("Allow agent (MCP)"));
    expect(props.onWithMcpChange).toHaveBeenCalledWith(true);

    await user.click(screen.getByRole("button", { name: "Create link" }));
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

    await user.click(screen.getByRole("button", { name: "Copy agent URL" }));
    expect(props.onCopy).toHaveBeenCalledWith(
      "mcp",
      "sample-agent-link",
      "Agent URL",
      agentRow.mcp_url,
    );

    await user.click(
      screen.getAllByRole("button", { name: "Stop sharing" })[0],
    );
    expect(props.onRevoke).toHaveBeenCalledWith("sample-review-link");

    await user.click(screen.getByRole("button", { name: "Copy guest link" }));
    expect(props.onCopy).toHaveBeenCalledWith(
      "link",
      "sample-guest-link",
      "Guest link",
      guestRow.url,
    );

    await user.click(screen.getByRole("button", { name: "Open room panel" }));
    expect(props.onOpenRoomPanel).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "End room" }));
    expect(props.onEndRoom).toHaveBeenCalledWith("sample-room");
  });

  it("shows copied labels", () => {
    const props = baseProps();
    props.copiedKey = shareCopyKey("link", "sample-review-link");
    render(<ShareDialogView {...props} />);
    expect(screen.getAllByRole("button", { name: "Copied" })).toHaveLength(1);

    props.copiedKey = shareCopyKey("link", "sample-guest-link");
    const { unmount } = render(<ShareDialogView {...props} />);
    expect(
      screen.getByRole("button", { name: "Copied guest link" }),
    ).toBeInTheDocument();
    unmount();
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
    expect(screen.getByLabelText("Anyone with the link")).toBeDisabled();
    expect(screen.getByLabelText("Allow agent (MCP)")).toBeDisabled();
  });

  it("shows a missing producer link as disabled", () => {
    const props = baseProps();
    props.rows = [guestRow];
    render(<ShareDialogView {...props} />);
    expect(screen.getByText("missing")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy producer link" }),
    ).toBeDisabled();
  });

  it("shows error over status in the live region", () => {
    const props = baseProps();
    props.error = "Clipboard unavailable";
    props.status = "Link copied";
    const { rerender } = render(<ShareDialogView {...props} />);
    expect(screen.getByText("Clipboard unavailable")).toBeInTheDocument();
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
