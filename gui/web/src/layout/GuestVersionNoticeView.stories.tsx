import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { dawShellStoryDecorator } from "./dawShellStoryDecorator";
import { GuestVersionNoticeView } from "./GuestVersionNoticeView";

const meta: Meta<typeof GuestVersionNoticeView> = {
  title: "Templates/GuestVersionNotice",
  component: GuestVersionNoticeView,
  tags: ["autodocs"],
  decorators: [dawShellStoryDecorator],
  parameters: { layout: "fullscreen" },
  args: {
    label: "Rough cut 2",
    followsLatest: false,
    newer: null,
    changed: false,
    author: "Ada",
    onReload: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof GuestVersionNoticeView>;

export const Frozen: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(/This link stays on this version/),
    ).toBeVisible();
  },
};

export const NewerAvailable: Story = {
  args: { newer: { label: "Rough cut 3" } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(/Ask Ada for a new link/),
    ).toBeVisible();
  },
};

export const FollowsLatest: Story = {
  args: { followsLatest: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(/follows the latest version/),
    ).toBeVisible();
  },
};

export const ChangedUnderGuest: Story = {
  args: { followsLatest: true, changed: true },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Reload" }),
    );
    await expect(args.onReload).toHaveBeenCalledOnce();
  },
};
