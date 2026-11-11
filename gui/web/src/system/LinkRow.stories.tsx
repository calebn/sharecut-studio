import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { LinkRow } from "./LinkRow";
import { middleTruncate } from "./linkText";

const LINK = "https://share.example.app/l/7Hq2mXk9TnP4vLr8Za3w";

const meta: Meta<typeof LinkRow> = {
  title: "System/LinkRow",
  component: LinkRow,
  tags: ["autodocs"],
  args: {
    access: "commenter",
    link: null,
    onCopy: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxInlineSize: "40rem" }}>
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
          "A link and what it allows: role, the link in mono cut in the middle, online-sharing glyph, who opened it with a count, the pin toggle, Copy and More (Allow AI assistants, Replace link, Stop sharing; the QR code is not built yet). There is no Create button; the link is made on first Copy. A blocked clipboard selects the text and the button reads Press ⌘C. On phone Copy becomes Share.\n\n**Motion.** Animations come later: Copied holds 2 s and eases back with `--motion-hover`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof LinkRow>;

export const Fresh: Story = {
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByText("Made when you copy it")).toBeInTheDocument();
    await userEvent.click(view.getByRole("button", { name: "Copy" }));
    await expect(args.onCopy).toHaveBeenCalledOnce();
  },
};

export const Copied: Story = { args: { link: LINK, copyState: "copied" } };

export const ClipboardBlocked: Story = {
  args: { link: LINK, copyState: "blocked" },
};

export const WithViewers: Story = {
  args: {
    link: LINK,
    openedBy: [
      { name: "Rosa", colorIndex: 2 },
      { name: "Jon", colorIndex: 1 },
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("img", { name: "Opened by Rosa, Jon" }),
    ).toBeInTheDocument();
  },
};

export const NoMix: Story = { args: { noMix: { onRefresh: fn() } } };

export const PhoneBlocked: Story = {
  args: { link: LINK, share: true, compact: true, copyState: "blocked" },
  decorators: [
    (Story) => (
      <div style={{ inlineSize: "22.5rem", maxInlineSize: "100%" }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Share" }),
    ).toBeInTheDocument();
  },
};

export const Phone: Story = {
  args: { link: LINK, share: true, compact: true },
  decorators: [
    (Story) => (
      <div style={{ inlineSize: "22.5rem", maxInlineSize: "100%" }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Share" }),
    ).toBeInTheDocument();
    await expect(middleTruncate(LINK)).toContain("…");
  },
};

export const RoleChoice: Story = {
  args: { onRole: fn() },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(
      view.getByRole("button", { name: "Editor: can edit" }),
    );
    await expect(args.onRole).toHaveBeenCalledWith("editor");
  },
};

export const Pinned: Story = {
  args: {
    access: "viewer",
    link: LINK,
    note: "Pinned to Rough cut",
    pin: { pressed: true, disabledReason: "Pinned when it was made." },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", {
        name: "Pin to this version",
      }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};

export const PinToggle: Story = {
  args: { pin: { pressed: false, onChange: fn() } },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Pin to this version",
      }),
    );
    await expect(args.pin?.onChange).toHaveBeenCalledWith(true);
  },
};

export const People: Story = {
  args: {
    link: LINK,
    openedBy: [
      { name: "Rosa", colorIndex: 2 },
      { name: "Jon", colorIndex: 1 },
      { name: "Mei", colorIndex: 3 },
      { name: "Ade", colorIndex: 4 },
    ],
    openedCount: 7,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByTestId("link-opened-count"),
    ).toHaveTextContent("7");
  },
};

export const More: Story = {
  args: {
    link: LINK,
    linkName: "Commenter link",
    more: [
      {
        id: "mcp",
        label: "Allow AI assistants",
        checked: false,
        onSelect: fn(),
      },
      { id: "stop", label: "Stop sharing", onSelect: fn() },
    ],
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "More for Commenter link",
      }),
    );
    const menu = await within(document.body).findByRole("menu");
    await waitFor(() => expect(menu).toBeVisible());
    await expect(
      within(menu).getByRole("menuitem", { name: "Stop sharing" }),
    ).toBeVisible();
  },
};

export const OnlineAnywhere: Story = {
  args: { link: LINK, reach: "anywhere" },
  play: async ({ canvasElement }) => {
    const glyph = within(canvasElement).getByRole("button", {
      name: "Reachable from anywhere",
    });
    await userEvent.click(glyph);
    await waitFor(() =>
      expect(within(canvasElement).getByText(/from anywhere/)).toBeVisible(),
    );
  },
};

export const NetworkOnly: Story = {
  args: { link: LINK, reach: "network" },
  play: async ({ canvasElement }) => {
    const glyph = within(canvasElement).getByRole("button", {
      name: "Only on this network",
    });
    await userEvent.click(glyph);
    await waitFor(() =>
      expect(
        within(canvasElement).getByText(
          /Only people on this network can open it/,
        ),
      ).toBeVisible(),
    );
  },
};
