import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { hostShareRow } from "../../test/fixtures";
import type { HostShareRow } from "../../types/shares";
import type { TunnelStatus } from "../../types/tunnel";
import { ShareSection } from "./ShareSection";
import {
  SHARE_DEFAULTS,
  type ShareChoices,
  type ShareCopiedKey,
  type ShareOptions,
  shareCopyKey,
} from "./shareLogic";

type Args = React.ComponentProps<typeof ShareSection>;

const reviewRow = hostShareRow({ created_at: "2026-09-01T10:00:00Z" });
const agentRow = hostShareRow({
  token: "sample-agent-link",
  url: "http://127.0.0.1:8765/r/sample-agent-link",
  docs_role: "editor",
  mcp_url: "http://127.0.0.1:8765/r/sample-agent-link/mcp",
  review_version_label: "Rough cut",
  follow_latest: false,
});
const guestRow = hostShareRow({
  token: "sample-guest-link",
  url: "http://127.0.0.1:8765/rec/sample-guest-link",
  kind: "record",
  docs_role: null,
  record_role: "guest",
  session_id: "sample-room",
  created_at: "2026-09-01T10:00:00Z",
});
const producerRow = hostShareRow({
  token: "sample-producer-link",
  url: "http://127.0.0.1:8765/rec/sample-producer-link",
  kind: "record",
  docs_role: null,
  record_role: "producer",
  session_id: "sample-room",
});

/** Chooses, creates, copies and stops in place on local state. */
function Live({ options, ...rest }: Args) {
  const [choices, setChoices] = useState<ShareChoices>(options.choices);
  const [rows, setRows] = useState<readonly HostShareRow[]>(options.rows);
  const [copiedKey, setCopiedKey] = useState<ShareCopiedKey | null>(
    options.copiedKey,
  );
  const live: ShareOptions = {
    ...options,
    choices,
    rows,
    copiedKey,
    onChoices: (next) => {
      setChoices(next);
      options.onChoices(next);
    },
    onCreate: () => {
      options.onCreate();
      setRows((now) => [
        ...now,
        hostShareRow({
          token: `new-link-${now.length}`,
          url: `http://127.0.0.1:8765/r/new-link-${now.length}`,
          docs_role: choices.role,
          mcp_url: choices.withMcp
            ? `http://127.0.0.1:8765/r/new-link-${now.length}/mcp`
            : null,
          follow_latest: !choices.freeze,
        }),
      ]);
    },
    onCopy: (kind, token, label, text) => {
      options.onCopy(kind, token, label, text);
      setCopiedKey(shareCopyKey(kind, token));
    },
    onStop: (token) => {
      options.onStop(token);
      setRows((now) => now.filter((row) => row.token !== token));
    },
    onEndRoom: (sessionId) => {
      options.onEndRoom(sessionId);
      setRows((now) => now.filter((row) => row.session_id !== sessionId));
    },
  };
  return <ShareSection {...rest} options={live} />;
}

const tunnelBase: TunnelStatus = {
  state: "online",
  reason: null,
  reason_kind: null,
  relay_host: "relay.example.test",
  public_base_url: "https://share.example.test",
  share_count: 2,
  retry_at: null,
};

const meta: Meta<typeof ShareSection> = {
  title: "Stages/Deliver/Share",
  component: ShareSection,
  tags: ["autodocs"],
  render: (args) => <Live {...args} />,
  args: {
    options: {
      rows: [],
      loaded: true,
      choices: SHARE_DEFAULTS,
      onChoices: fn(),
      busy: false,
      recovery: { kind: "idle" },
      error: null,
      status: null,
      copiedKey: null,
      blockedKey: null,
      onCreate: fn(),
      onRefreshMix: fn(),
      onCopy: fn(),
      onStop: fn(),
      onCreateRecord: fn(),
      onReplaceInvite: fn(),
      onEndRoom: fn(),
      onOpenRecord: fn(),
    },
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxInlineSize: "23.5rem" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "Review links and record rooms for the open project. The role, MCP and freeze choices apply to the next link; Create review link makes it (and copies it when the browser allows), and each link in the list has its own Copy and an in-place Stop sharing. Online sharing status sits on top; a link that only this network can open says so.\n\n**Motion.** Animations come later: the Copied label holds for 2 s and then eases back.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ShareSection>;

export const Empty: Story = {
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByText("No review links yet.")).toBeVisible();
    await expect(view.getByText("No record rooms yet.")).toBeVisible();
    await expect(
      view.getByRole("button", { name: "Commenter" }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(view.getByRole("button", { name: "Viewer" }));
    await expect(args.options.onChoices).toHaveBeenLastCalledWith({
      ...SHARE_DEFAULTS,
      role: "viewer",
    });
    await userEvent.click(
      view.getByRole("button", { name: "Create review link" }),
    );
    await expect(args.options.onCreate).toHaveBeenCalledOnce();
    await expect(
      view.getByRole("button", { name: "Copy Viewer link" }),
    ).toBeVisible();
  },
};

export const LoadingList: Story = {
  args: { options: { ...meta.args?.options, loaded: false } as ShareOptions },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Looking for your links…"),
    ).toBeVisible();
  },
};

export const LinkOptions: Story = {
  args: {
    options: {
      ...meta.args?.options,
      choices: { role: "editor", withMcp: true, freeze: true },
    } as ShareOptions,
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      view.getByRole("button", { name: "Allow AI assistants (MCP)" }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(
      view.getByRole("button", { name: "Freeze on the current version" }),
    );
  },
};

export const Creating: Story = {
  args: { options: { ...meta.args?.options, busy: true } as ShareOptions },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Create review link" }),
    ).toBeDisabled();
  },
};

export const Unavailable: Story = {
  args: {
    options: {
      ...meta.args?.options,
      blockedReason: "Open a project first.",
    } as ShareOptions,
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      view.getByRole("button", { name: "Create review link" }),
    ).toBeDisabled();
    await expect(view.getByText("Open a project first.")).toBeVisible();
  },
};

export const LiveLinks: Story = {
  args: {
    options: {
      ...meta.args?.options,
      rows: [reviewRow, agentRow],
    } as ShareOptions,
  },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(
      view.getByRole("button", { name: "Copy Commenter link" }),
    );
    await expect(
      view.getByRole("button", { name: "Copied Commenter link" }),
    ).toBeVisible();
    await userEvent.click(
      view.getAllByRole("button", { name: "Stop sharing" })[1],
    );
    await expect(args.options.onStop).not.toHaveBeenCalled();
    const confirm = view.getByRole("group", {
      name: "Stop sharing this Editor link? Anyone using it loses access.",
    });
    await expect(
      within(confirm).getByRole("button", { name: "Keep link" }),
    ).toHaveFocus();
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Stop sharing" }),
    );
    await expect(args.options.onStop).toHaveBeenCalledWith("sample-agent-link");
    await expect(view.queryByText("sample-agent-link")).toBeNull();
  },
};

export const JustCreated: Story = {
  args: {
    options: {
      ...meta.args?.options,
      rows: [reviewRow],
      copiedKey: shareCopyKey("link", reviewRow.token),
      status: "Review link created and copied",
    } as ShareOptions,
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      view.getByText("Review link created and copied"),
    ).toBeVisible();
    await expect(
      view.getByRole("button", { name: "Copied Commenter link" }),
    ).toBeVisible();
  },
};

export const CopyBlocked: Story = {
  args: {
    options: {
      ...meta.args?.options,
      rows: [reviewRow],
      blockedKey: shareCopyKey("link", reviewRow.token),
      status:
        "Review link created. Your browser would not copy it; press the copy shortcut to copy the selected link.",
    } as ShareOptions,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", {
        name: /^Press .* Commenter link$/,
      }),
    ).toBeVisible();
  },
};

export const CorsWarning: Story = {
  args: {
    options: {
      ...meta.args?.options,
      rows: [reviewRow],
      error:
        "Link created, but its bucket has no CORS rule for https://sharecut.studio, so guests stream through your connection until you add one. The rule to paste is in docs/host-online-relay.md.",
    } as ShareOptions,
  },
};

export const NoMix: Story = {
  args: {
    options: {
      ...meta.args?.options,
      recovery: {
        kind: "needs_refresh",
        message:
          "This project has no mix yet. Refresh the mix to create the link.",
        refreshError: null,
      },
    } as ShareOptions,
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Refresh mix" }),
    );
    await expect(args.options.onRefreshMix).toHaveBeenCalledOnce();
  },
};

export const StaleMix: Story = {
  args: {
    options: {
      ...meta.args?.options,
      recovery: {
        kind: "needs_refresh",
        message:
          "The mix preview is out of date. Refresh it before creating a review link.",
        refreshError: "Render failed",
      },
    } as ShareOptions,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Refresh failed: Render failed"),
    ).toBeVisible();
  },
};

export const RefreshingMix: Story = {
  args: {
    options: {
      ...meta.args?.options,
      busy: true,
      recovery: { kind: "refreshing" },
    } as ShareOptions,
  },
};

export const RetryingCreate: Story = {
  args: {
    options: {
      ...meta.args?.options,
      busy: true,
      recovery: { kind: "retrying" },
    } as ShareOptions,
  },
};

export const StaleMaster: Story = {
  args: {
    options: {
      ...meta.args?.options,
      error:
        "The mastered mix is out of date. Export a new master before creating a review link.",
    } as ShareOptions,
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole("alert")).toBeVisible();
    await expect(
      view.queryByRole("button", { name: "Refresh mix" }),
    ).toBeNull();
  },
};

export const NetworkOnly: Story = {
  args: {
    options: { ...meta.args?.options, rows: [reviewRow] } as ShareOptions,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        "Only people on this network can listen. Turn on online sharing to reach anyone.",
      ),
    ).toBeVisible();
  },
};

export const OnlineSharingOn: Story = {
  args: {
    options: {
      ...meta.args?.options,
      rows: [reviewRow],
      tunnel: tunnelBase,
    } as ShareOptions,
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText("Guests can open your links")).toBeVisible();
    await expect(view.queryByText(/Only people on this network/)).toBeNull();
  },
};

export const OnlineSharingReconnecting: Story = {
  args: {
    options: {
      ...meta.args?.options,
      rows: [reviewRow],
      tunnel: {
        ...tunnelBase,
        state: "reconnecting",
        reason_kind: "network",
        retry_at: Date.now() / 1000 + 30,
      },
    } as ShareOptions,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(/Trying again|Next try at/),
    ).toBeVisible();
  },
};

export const OnlineSharingNotReachable: Story = {
  args: {
    options: {
      ...meta.args?.options,
      rows: [reviewRow],
      tunnel: { ...tunnelBase, state: "offline", reason_kind: "auth" },
    } as ShareOptions,
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByText("How to fix"));
    await expect(
      view.getByRole("link", { name: /Online sharing guide/ }),
    ).toBeVisible();
  },
};

export const OnlineSharingOff: Story = {
  args: {
    options: {
      ...meta.args?.options,
      tunnel: { ...tunnelBase, state: "off" },
    } as ShareOptions,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Online sharing is off"),
    ).toBeVisible();
  },
};

export const RecordRoom: Story = {
  args: {
    options: {
      ...meta.args?.options,
      rows: [guestRow, producerRow],
    } as ShareOptions,
  },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(
      view.getByRole("button", { name: "Open Record stage" }),
    );
    await expect(args.options.onOpenRecord).toHaveBeenCalledOnce();
    await userEvent.click(view.getByRole("button", { name: "End room" }));
    await userEvent.click(
      within(
        view.getByRole("group", { name: /^End this record room/ }),
      ).getByRole("button", { name: "End room" }),
    );
    await expect(view.getByText("No record rooms yet.")).toBeVisible();
  },
};

export const MissingProducer: Story = {
  args: {
    options: { ...meta.args?.options, rows: [guestRow] } as ShareOptions,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Copy producer link" }),
    ).toBeDisabled();
  },
};

export const ClosedInvite: Story = {
  args: {
    options: {
      ...meta.args?.options,
      rows: [{ ...guestRow, invite_closed: true }, producerRow],
    } as ShareOptions,
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Replace guest invite",
      }),
    );
    await expect(args.options.onReplaceInvite).toHaveBeenCalledWith(
      "sample-guest-link",
    );
  },
};

export const Loading: Story = { args: { state: "loading" } };

export const Phone: Story = {
  args: {
    options: {
      ...meta.args?.options,
      rows: [reviewRow, agentRow],
      tunnel: { ...tunnelBase, state: "off" },
    } as ShareOptions,
  },
  decorators: [
    (Story) => (
      <div style={{ inlineSize: "22.5rem", maxInlineSize: "100%" }}>
        <Story />
      </div>
    ),
  ],
};

export const PhoneStopSharing: Story = {
  args: {
    options: { ...meta.args?.options, rows: [agentRow] } as ShareOptions,
  },
  decorators: Phone.decorators,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole("button", { name: "Stop sharing" }));
    await expect(
      view.getByRole("group", { name: /^Stop sharing this Editor link/ }),
    ).toBeVisible();
  },
};

export const Dark: Story = {
  args: {
    options: {
      ...meta.args?.options,
      rows: [reviewRow, guestRow, producerRow],
      tunnel: tunnelBase,
    } as ShareOptions,
  },
  globals: { theme: "dark" },
};
