import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { SaveStatePillView } from "./SaveStatePillView";

const meta: Meta<typeof SaveStatePillView> = {
  title: "Templates/SaveStatePillView",
  component: SaveStatePillView,
  tags: ["autodocs"],
  args: { onSendNow: fn(), onSeeWhy: fn(), onRetry: fn() },
  decorators: [
    (Story) => (
      <div className="status-bar">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SaveStatePillView>;

export const Saved: Story = {
  args: { state: { kind: "saved" } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Saved to project"),
    ).toBeVisible();
  },
};

export const Saving: Story = {
  args: { state: { kind: "saving" } },
};

export const WaitingToSend: Story = {
  args: { state: { kind: "waiting", count: 3 } },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Not saved yet · 3 waiting to send",
      }),
    );
    await expect(args.onSendNow).toHaveBeenCalledOnce();
  },
};

export const Refused: Story = {
  args: {
    state: {
      kind: "failed",
      cause: "refused",
      reason: "Envelope changed since this edit was queued",
    },
  },
};

export const Unreadable: Story = {
  args: { state: { kind: "failed", cause: "unreadable" } },
};
