import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { dawShellStoryDecorator } from "../../layout/dawShellStoryDecorator";
import { LoadFailureBanner } from "./LoadFailureBanner";

const meta: Meta<typeof LoadFailureBanner> = {
  title: "Templates/LoadFailureBanner",
  component: LoadFailureBanner,
  tags: ["autodocs"],
  decorators: [dawShellStoryDecorator],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof LoadFailureBanner>;

export const Failed: Story = {
  args: {
    failure: { message: "The server did not answer.", onRetry: fn() },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(args.failure?.onRetry).toHaveBeenCalledOnce();
  },
};

export const Recovering: Story = {
  args: {
    failure: {
      message: "The server is still working. Retrying…",
      onRetry: fn(),
      recovering: true,
    },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "Still loading transcript and history.",
    );
  },
};
