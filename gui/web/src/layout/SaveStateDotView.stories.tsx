import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { SaveStateDotView } from "./SaveStateDotView";

const meta: Meta<typeof SaveStateDotView> = {
  title: "Templates/SaveStateDotView",
  component: SaveStateDotView,
  tags: ["autodocs"],
  args: { attention: { kind: "button", activate: fn() } },
  decorators: [
    (Story) => (
      <div className="status-bar">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SaveStateDotView>;

export const Saved: Story = {
  args: { state: { kind: "saved" } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("img", { name: "Saved to project" }),
    ).toBeVisible();
  },
};

export const Saving: Story = {
  args: { state: { kind: "saving" } },
};

export const WaitingToSend: Story = {
  args: {
    state: { kind: "waiting", count: 3 },
    attention: { kind: "button", activate: fn() },
  },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Not saved yet · 3 waiting to send",
      }),
    );
    if (args.attention.kind === "button") {
      await expect(args.attention.activate).toHaveBeenCalledOnce();
    }
  },
};

export const Unreadable: Story = {
  args: {
    state: { kind: "failed", cause: "unreadable" },
    attention: { kind: "passive" },
  },
};
