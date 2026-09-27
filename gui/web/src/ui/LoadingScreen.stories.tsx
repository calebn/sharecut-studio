import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { LoadingScreen } from "./index";

const meta: Meta<typeof LoadingScreen> = {
  title: "Organisms/LoadingScreen",
  component: LoadingScreen,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof LoadingScreen>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Loading…")).toBeVisible();
  },
};

export const ProjectLabel: Story = {
  args: { label: "Loading project…" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Loading project…"),
    ).toBeVisible();
  },
};
