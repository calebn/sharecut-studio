import type { Meta, StoryObj } from "@storybook/react-vite";
import "../styles/partials/record-entry.css";
import { Declined } from "./Declined";

const meta: Meta<typeof Declined> = {
  title: "Record/Declined",
  component: Declined,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof Declined>;

export const Default: Story = {};
