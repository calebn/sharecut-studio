import type { Meta, StoryObj } from "@storybook/react-vite";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import "../styles/partials/record-entry.css";
import { Declined } from "./Declined";

const meta: Meta<typeof Declined> = {
  title: "Templates/Declined",
  component: Declined,
  tags: ["autodocs"],
  parameters: { ...isolatedStoryParameters, layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof Declined>;

export const Default: Story = {};
