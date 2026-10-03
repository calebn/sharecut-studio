import type { Meta, StoryObj } from "@storybook/react-vite";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import "../styles/partials/record-entry.css";
import { FullRoom } from "./FullRoom";

const meta: Meta<typeof FullRoom> = {
  title: "Templates/FullRoom",
  component: FullRoom,
  tags: ["autodocs"],
  parameters: { ...isolatedStoryParameters, layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof FullRoom>;

export const Default: Story = {};
