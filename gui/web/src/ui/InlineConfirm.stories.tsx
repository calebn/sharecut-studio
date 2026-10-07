import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { InlineConfirm } from "./InlineConfirm";

const meta: Meta<typeof InlineConfirm> = {
  title: "Molecules/InlineConfirm",
  component: InlineConfirm,
  tags: ["autodocs"],
  args: {
    prompt: "Stop sharing this Viewer link? Anyone using it loses access.",
    keepLabel: "Keep link",
    actionLabel: "Stop sharing",
    onKeep: fn(),
    onConfirm: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof InlineConfirm>;

export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Keep link" }),
    ).toHaveFocus();
    await userEvent.click(canvas.getByRole("button", { name: "Stop sharing" }));
    await expect(args.onConfirm).toHaveBeenCalledOnce();
  },
};

export const Busy: Story = {
  args: { disabled: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Stop sharing" }),
    ).toBeDisabled();
  },
};
