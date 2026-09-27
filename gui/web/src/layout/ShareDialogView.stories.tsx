import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { hostShareRow } from "../test/fixtures";
import { Button } from "../ui/Button";
import { ShareDialogView } from "./ShareDialogView";
import { type ShareCopiedKey, shareCopyKey } from "./shareCopyKey";

const reviewRow = hostShareRow();
const agentRow = hostShareRow({
  token: "sample-agent-link",
  url: "http://127.0.0.1:8765/r/sample-agent-link",
  docs_role: "editor",
  mcp_url: "http://127.0.0.1:8765/r/sample-agent-link/mcp",
  review_version_label: null,
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

async function openDialog(canvasElement: HTMLElement) {
  if (!within(document.body).queryByRole("dialog")) {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Open share dialog",
      }),
    );
  }
  return within(document.body).getByRole("dialog", { name: "Share" });
}

function ShareDialogPreview({
  initiallyOpen,
  ...args
}: ComponentProps<typeof ShareDialogView> & { initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [role, setRole] = useState(args.role);
  const [withMcp, setWithMcp] = useState(args.withMcp);
  const [rows, setRows] = useState(args.rows);
  const [copiedKey, setCopiedKey] = useState<ShareCopiedKey | null>(
    args.copiedKey,
  );
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        Open share dialog
      </Button>
      <ShareDialogView
        {...args}
        open={open}
        role={role}
        withMcp={withMcp}
        rows={rows}
        copiedKey={copiedKey}
        onClose={() => {
          setOpen(false);
          args.onClose();
        }}
        onRoleChange={(next) => {
          setRole(next);
          args.onRoleChange(next);
        }}
        onWithMcpChange={(next) => {
          setWithMcp(next);
          args.onWithMcpChange(next);
        }}
        onCopy={(kind, token, label, text) => {
          setCopiedKey(shareCopyKey(kind, token));
          args.onCopy(kind, token, label, text);
        }}
        onRevoke={(token) => {
          setRows((prev) => prev.filter((r) => r.token !== token));
          args.onRevoke(token);
        }}
        onEndRoom={(sessionId) => {
          setRows((prev) => prev.filter((r) => r.session_id !== sessionId));
          args.onEndRoom(sessionId);
        }}
      />
    </>
  );
}

const meta: Meta<typeof ShareDialogView> = {
  title: "Templates/ShareDialog",
  component: ShareDialogView,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    open: false,
    onClose: fn(),
    role: "commenter",
    onRoleChange: fn(),
    withMcp: false,
    onWithMcpChange: fn(),
    rows: [],
    busy: false,
    error: null,
    status: null,
    copiedKey: null,
    onCreate: fn(),
    onCreateRecord: fn(),
    onCopy: fn(),
    onRevoke: fn(),
    onEndRoom: fn(),
    onOpenRoomPanel: fn(),
  },
  argTypes: { open: { control: false } },
  render: (args, context) => (
    <ShareDialogPreview
      {...args}
      initiallyOpen={context.viewMode === "story"}
    />
  ),
};

export default meta;
type Story = StoryObj<typeof ShareDialogView>;

export const Empty: Story = {
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByText("No live review links."),
    ).toBeVisible();
    await expect(
      within(dialog).getByText("No live record rooms."),
    ).toBeVisible();
  },
};

export const LiveLinks: Story = {
  args: { rows: [reviewRow, agentRow] },
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await userEvent.click(
      within(dialog).getAllByRole("button", { name: "Copy link" })[0],
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Copied" }),
      ).toBeVisible(),
    );
    await userEvent.click(
      within(dialog).getAllByRole("button", { name: "Stop sharing" })[1],
    );
    await expect(args.onRevoke).toHaveBeenCalledWith("sample-agent-link");
    await waitFor(() =>
      expect(
        within(dialog).queryByText("sample-agent-link"),
      ).not.toBeInTheDocument(),
    );
  },
};

export const RecordRoom: Story = {
  args: { rows: [guestRow, producerRow] },
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Open room panel" }),
    );
    await expect(args.onOpenRoomPanel).toHaveBeenCalledOnce();
    const reopened = await openDialog(canvasElement);
    await userEvent.click(
      within(reopened).getByRole("button", { name: "End room" }),
    );
    await waitFor(() =>
      expect(within(reopened).getByText("No live record rooms.")).toBeVisible(),
    );
  },
};

export const MissingProducer: Story = {
  args: { rows: [guestRow] },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByRole("button", { name: "Copy producer link" }),
    ).toBeDisabled();
  },
};

export const Busy: Story = {
  args: { rows: [reviewRow, agentRow], busy: true },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByRole("button", { name: "Create link" }),
    ).toBeDisabled();
  },
};

export const ClipboardError: Story = {
  args: { error: "Clipboard unavailable" },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByText("Clipboard unavailable"),
    ).toBeVisible();
  },
};

export const Phone: Story = {
  args: { rows: [reviewRow, agentRow] },
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(dialog).toBeVisible();
  },
};
