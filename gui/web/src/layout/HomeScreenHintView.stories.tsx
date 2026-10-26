import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { dawShellStoryDecorator } from "./dawShellStoryDecorator";
import { HomeScreenHintView } from "./HomeScreenHintView";

const meta: Meta<typeof HomeScreenHintView> = {
  title: "Templates/HomeScreenHint",
  component: HomeScreenHintView,
  tags: ["autodocs"],
  decorators: [dawShellStoryDecorator],
  args: { onDismiss: fn() },
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof HomeScreenHintView>;

export const Safari: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Add to Home Screen/)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Dismiss" }));
    await expect(args.onDismiss).toHaveBeenCalledOnce();
  },
};

export const Phone: Story = {
  ...recordMobileViewport,
  parameters: { ...recordMobileViewport.parameters, dawShellPhone: true },
};
