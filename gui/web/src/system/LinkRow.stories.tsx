import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
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
          "A link and what it allows: role, the link in mono cut in the middle, who opened it and Copy. There is no Create button; the link is made on first Copy. A blocked clipboard selects the text and the button reads Press ⌘C. On phone Copy becomes Share.\n\n**Motion.** Animations come later: Copied holds 2 s and eases back with `--motion-hover`.",
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
