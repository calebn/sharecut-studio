import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { InlineConfirm } from "./InlineConfirm";

const meta: Meta<typeof InlineConfirm> = {
  title: "Molecules/InlineConfirm",
  component: InlineConfirm,
  tags: ["autodocs"],
  args: {
    prompt: "Stop this take? What was recorded so far is kept.",
    keepLabel: "Keep recording",
    actionLabel: "Stop take",
    onKeep: fn(),
    onConfirm: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof InlineConfirm>;

export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Keep recording" }),
      ).toHaveFocus(),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Stop take" }));
    await expect(args.onConfirm).toHaveBeenCalledOnce();
  },
};

export const Busy: Story = {
  args: { disabledReason: "Wait for the current action to finish." },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Stop take" }),
    ).toBeDisabled();
  },
};
