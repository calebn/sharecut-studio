import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { offlineConflict } from "../test/fixtures";
import { dawShellStoryDecorator } from "./dawShellStoryDecorator";
import { GuestAttentionBannerView } from "./GuestAttentionBannerView";

const meta: Meta<typeof GuestAttentionBannerView> = {
  title: "Templates/GuestAttentionBanner",
  component: GuestAttentionBannerView,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="daw-shell-banners">
        <Story />
      </div>
    ),
    dawShellStoryDecorator,
  ],
  args: {
    pending: 0,
    conflicts: [],
    onDismissAll: fn(),
  },
};
export default meta;
type Story = StoryObj<typeof GuestAttentionBannerView>;

export const PendingHostEdits: Story = {
  args: { pending: 2 },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("2 pending"),
    ).toBeInTheDocument();
  },
};

export const Conflicts: Story = {
  args: {
    conflicts: [
      offlineConflict({
        command: { command_id: "conflict-1", type: "SetEnvelope" },
        reason: "Envelope changed since this edit was queued",
      }),
      offlineConflict({
        command: { command_id: "conflict-2", type: "TrimClip" },
        reason: "Clip was already trimmed",
      }),
    ],
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Dismiss all" }));
    await expect(args.onDismissAll).toHaveBeenCalledTimes(1);
  },
};

export const PendingAndConflict: Story = {
  args: {
    pending: 1,
    conflicts: [
      offlineConflict({
        command: { command_id: "conflict-3", type: "SetEnvelope" },
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("1 pending, 1 conflict"),
    ).toBeInTheDocument();
  },
};

export const PhoneManyConflicts: Story = {
  parameters: { ...recordMobileViewport.parameters, dawShellPhone: true },
  globals: recordMobileViewport.globals,
  args: {
    conflicts: Array.from({ length: 7 }, (_, i) =>
      offlineConflict({ command: { command_id: `conflict-phone-${i}` } }),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("listitem")).toHaveLength(6);
    await expect(canvas.getByText("+2 more")).toBeInTheDocument();
  },
};
