import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { DialogLauncher } from "../test/DialogLauncher";
import { hostShareRow } from "../test/fixtures";
import { openDialogByLauncher, useArgState } from "../test/storyDialog";
import type { TunnelStatus } from "../types/tunnel";
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

const openDialog = (canvasElement: HTMLElement) =>
  openDialogByLauncher(canvasElement, {
    launcherName: "Open share dialog",
    dialogName: "Share",
  });

function ShareDialogPreview({
  initiallyOpen,
  ...args
}: ComponentProps<typeof ShareDialogView> & { initiallyOpen: boolean }) {
  const [role, setRole] = useArgState(args.role);
  const [withMcp, setWithMcp] = useArgState(args.withMcp);
  const [rows, setRows] = useArgState(args.rows);
  const [copiedKey, setCopiedKey] = useArgState<ShareCopiedKey | null>(
    args.copiedKey,
  );
  return (
    <DialogLauncher label="Open share dialog" initiallyOpen={initiallyOpen}>
      {(open, close) => (
        <ShareDialogView
          {...args}
          open={open}
          role={role}
          withMcp={withMcp}
          rows={rows}
          copiedKey={copiedKey}
          onClose={() => {
            close();
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
          onOpenRoomPanel={() => {
            close();
            args.onOpenRoomPanel();
          }}
        />
      )}
    </DialogLauncher>
  );
}

const meta: Meta<typeof ShareDialogView> = {
  title: "Templates/ShareDialog",
  component: ShareDialogView,
  tags: ["autodocs"],
  parameters: { ...isolatedStoryParameters, layout: "padded" },
  args: {
    open: false,
    onClose: fn(),
    role: "commenter",
    onRoleChange: fn(),
    withMcp: false,
    onWithMcpChange: fn(),
    rows: [],
    busy: false,
    createRecovery: { kind: "idle" },
    error: null,
    status: null,
    copiedKey: null,
    lastCreated: null,
    onCreate: fn(),
    onRefreshMix: fn(),
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
      within(dialog).getByText("No review links yet."),
    ).toBeVisible();
    await expect(
      within(dialog).getByText("No record rooms yet."),
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
        within(dialog).getByRole("button", { name: "Copied link" }),
      ).toBeVisible(),
    );
    await userEvent.click(
      within(dialog).getAllByRole("button", { name: "Stop sharing" })[1],
    );
    await expect(args.onRevoke).not.toHaveBeenCalled();
    const confirm = within(dialog).getByRole("group", {
      name: "Stop sharing this Editor link? Anyone using it loses access.",
    });
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Stop sharing" }),
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
    await waitFor(() =>
      expect(within(document.body).queryByRole("dialog")).toBeNull(),
    );
    const reopened = await openDialog(canvasElement);
    await userEvent.click(
      within(reopened).getByRole("button", { name: "End room" }),
    );
    await userEvent.click(
      within(
        within(reopened).getByRole("group", { name: /^End this record room/ }),
      ).getByRole("button", { name: "End room" }),
    );
    await waitFor(() =>
      expect(within(reopened).getByText("No record rooms yet.")).toBeVisible(),
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
      within(dialog).getByRole("button", { name: "Create review link" }),
    ).toBeDisabled();
  },
};

export const JustCreated: Story = {
  args: {
    rows: [reviewRow],
    lastCreated: {
      token: reviewRow.token,
      url: reviewRow.url ?? "",
      kind: "review",
    },
    status: "Review link created and copied",
    copiedKey: shareCopyKey("link", reviewRow.token),
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByText("Review link created and copied"),
    ).toBeVisible();
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

const tunnelBase: TunnelStatus = {
  state: "online",
  reason: null,
  reason_kind: null,
  relay_host: "relay.example.test",
  public_base_url: "https://share.example.test",
  share_count: 2,
  retry_at: null,
};

export const OnlineSharingOn: Story = {
  args: { rows: [reviewRow], tunnel: tunnelBase },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByText("Guests can open your links"),
    ).toBeVisible();
  },
};

export const OnlineSharingReconnecting: Story = {
  args: {
    rows: [reviewRow],
    tunnel: {
      ...tunnelBase,
      state: "reconnecting",
      reason_kind: "network",
      retry_at: Date.now() / 1000 + 30,
    },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByText(/Trying again|Next try at/),
    ).toBeVisible();
  },
};

export const OnlineSharingNotReachable: Story = {
  args: {
    rows: [reviewRow],
    tunnel: { ...tunnelBase, state: "offline", reason_kind: "auth" },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await userEvent.click(within(dialog).getByText("How to fix"));
    await expect(
      within(dialog).getByRole("link", { name: /Online sharing guide/ }),
    ).toBeVisible();
  },
};

export const OnlineSharingOff: Story = {
  args: { rows: [], tunnel: { ...tunnelBase, state: "off" } },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByText("Online sharing is off"),
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
