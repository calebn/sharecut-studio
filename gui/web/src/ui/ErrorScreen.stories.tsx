import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ErrorScreen } from "./index";

const meta: Meta<typeof ErrorScreen> = {
  title: "Organisms/ErrorScreen",
  component: ErrorScreen,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof ErrorScreen>;

export const Default: Story = {
  args: { message: "Missing ?project= query parameter" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("alert")).toHaveTextContent(
      "Missing ?project= query parameter",
    );
  },
};
