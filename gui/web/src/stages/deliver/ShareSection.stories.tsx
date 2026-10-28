import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import type { TunnelStatus } from "../../types/tunnel";
import { ShareSection } from "./ShareSection";
import {
  AGENT_ROW,
  GUEST_ROW,
  ONLINE,
  PRODUCER_ROW,
  REVIEW_ROW,
  shareOptions,
} from "./shareFixture";

const tunnel = (over: Partial<TunnelStatus>): TunnelStatus => ({
  ...ONLINE,
  ...over,
});

const meta: Meta<typeof ShareSection> = {
  title: "Stages/Deliver/Share",
  component: ShareSection,
  tags: ["autodocs"],
  args: {
    options: shareOptions(fn, {
      rows: [REVIEW_ROW, AGENT_ROW, GUEST_ROW, PRODUCER_ROW],
      tunnel: ONLINE,
      reach: "anywhere",
    }),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxInlineSize: "30rem" }}>
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
          "The host's listen links: whether guests can reach them, the role a new review link gets, the review links that are out (Copy, Copy MCP URL, Stop sharing after a confirm) and the record rooms (guest and producer links, Open room panel, End room after a confirm). Stop sharing and End room ask first, in place.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ShareSection>;

export const Links: Story = {
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByText("Guests can open your links")).toBeVisible();
    await userEvent.click(view.getByRole("radio", { name: "Editor" }));
    await expect(args.options.onRole).toHaveBeenCalledWith("editor");
    await userEvent.click(
      view.getByRole("button", { name: "Create review link" }),
    );
    await expect(args.options.onCreate).toHaveBeenCalledOnce();
    await userEvent.click(view.getAllByRole("button", { name: "Copy" })[0]);
    await expect(args.options.onCopy).toHaveBeenCalledWith(
      "link",
      "sample-review-link",
      "Link",
      REVIEW_ROW.url,
    );
  },
};

export const StopSharing: Story = {
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(
      view.getAllByRole("button", { name: "Stop sharing" })[0],
    );
    await expect(
      view.getByRole("group", {
        name: "Stop sharing this Commenter link? Anyone using it loses access.",
      }),
    ).toBeVisible();
    await userEvent.click(
      within(view.getByRole("group", { name: /^Stop sharing this/ })).getByRole(
        "button",
        { name: "Stop sharing" },
      ),
    );
    await expect(args.options.onRevoke).toHaveBeenCalledWith(
      "sample-review-link",
    );
  },
};

export const EndRoom: Story = {
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole("button", { name: "End room" }));
    await userEvent.click(
      within(
        view.getByRole("group", { name: /^End this record room/ }),
      ).getByRole("button", { name: "End room" }),
    );
    await expect(args.options.onEndRoom).toHaveBeenCalledWith("sample-room");
  },
};

export const NoLinks: Story = {
  args: { options: shareOptions(fn, { tunnel: ONLINE }) },
};

export const Copied: Story = {
  args: {
    options: shareOptions(fn, {
      rows: [REVIEW_ROW],
      copiedKey: "link:sample-review-link",
      lastCreated: {
        token: "sample-review-link",
        url: REVIEW_ROW.url ?? "",
        kind: "review",
      },
      status: "Review link created and copied",
    }),
  },
};

export const ThisNetworkOnly: Story = {
  args: {
    options: shareOptions(fn, {
      rows: [REVIEW_ROW],
      tunnel: tunnel({ state: "off" }),
      reach: "network",
    }),
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText("Online sharing is off")).toBeVisible();
    await expect(
      view.getByText(
        "Only people on this network can listen. Turn on online sharing to reach anyone.",
      ),
    ).toBeVisible();
  },
};

export const Offline: Story = {
  args: {
    options: shareOptions(fn, {
      rows: [REVIEW_ROW],
      tunnel: tunnel({ state: "offline", reason_kind: "network" }),
      reach: "anywhere",
    }),
  },
};

export const NeedsMix: Story = {
  args: {
    options: shareOptions(fn, {
      createRecovery: {
        kind: "needs_refresh",
        message:
          "This project has no mix yet. Refresh the mix to create the link.",
        refreshError: "Render busy",
      },
    }),
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Refresh mix" }),
    );
    await expect(args.options.onRefreshMix).toHaveBeenCalledOnce();
  },
};

export const Refreshing: Story = {
  args: {
    options: shareOptions(fn, { createRecovery: { kind: "refreshing" } }),
  },
};

export const Failed: Story = {
  args: {
    options: shareOptions(fn, {
      rows: [REVIEW_ROW],
      error: "Could not reach the share service.",
    }),
  },
};

export const Busy: Story = {
  args: {
    options: shareOptions(fn, {
      rows: [REVIEW_ROW, GUEST_ROW, PRODUCER_ROW],
      busy: true,
    }),
  },
};

export const ClosedInvite: Story = {
  args: {
    options: shareOptions(fn, {
      rows: [{ ...GUEST_ROW, invite_closed: true }, PRODUCER_ROW],
    }),
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Replace guest invite",
      }),
    );
    await expect(args.options.onReplaceRecordInvite).toHaveBeenCalledWith(
      "sample-guest-link",
    );
  },
};

export const Loading: Story = { args: { state: "loading" } };

export const Phone: Story = { args: { layout: "phone" } };
