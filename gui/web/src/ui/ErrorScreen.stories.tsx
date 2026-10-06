import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { ErrorScreen } from "./index";

const meta: Meta<typeof ErrorScreen> = {
  title: "Organisms/ErrorScreen",
  component: ErrorScreen,
  tags: ["autodocs"],
  parameters: { ...isolatedStoryParameters, layout: "fullscreen" },
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

export const WithNextStep: Story = {
  args: {
    message: "This link does not open the project.",
    hint: "Ask the person who shared it for a new link.",
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("alert")).toHaveTextContent(
      "Ask the person who shared it for a new link.",
    );
  },
};
