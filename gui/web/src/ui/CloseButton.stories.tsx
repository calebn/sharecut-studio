import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { CloseButton } from "./index";

const meta: Meta<typeof CloseButton> = {
  title: "Atoms/CloseButton",
  component: CloseButton,
  tags: ["autodocs"],
  args: { onClick: fn() },
};

export default meta;
type Story = StoryObj<typeof CloseButton>;

export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const button = within(canvasElement).getByRole("button", {
      name: "Close",
    });
    await userEvent.click(button);
    await expect(args.onClick).toHaveBeenCalledOnce();
    await expect(button).toHaveAttribute("title", "Close (Esc)");
  },
};
