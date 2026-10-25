import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { STOP_CONFIRM_COPY } from "./hostControls";
import { recordStoryDecorator } from "./recordStoryDecorator";
import { StopTakeControl } from "./StopTakeControl";

const meta: Meta<typeof StopTakeControl> = {
  title: "Templates/StopTakeControl",
  component: StopTakeControl,
  tags: ["autodocs"],
  decorators: [recordStoryDecorator],
  parameters: { layout: "padded" },
  args: { busy: false, onStop: fn() },
};

export default meta;
type Story = StoryObj<typeof StopTakeControl>;

export const Idle: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Stop" }),
    ).toBeVisible();
  },
};

export const Confirming: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Stop" }));
    await expect(canvas.getByText(STOP_CONFIRM_COPY)).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Keep recording" }),
    ).toHaveFocus();
    await userEvent.click(canvas.getByRole("button", { name: "Stop take" }));
    await expect(args.onStop).toHaveBeenCalledOnce();
  },
};

export const Busy: Story = {
  args: { busy: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Stop" }),
    ).toHaveAttribute("aria-disabled", "true");
  },
};
