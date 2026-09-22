import type { Meta, StoryObj } from "@storybook/react-vite";
import { Declined } from "./Declined";

const meta: Meta<typeof Declined> = {
  title: "Record/Declined",
  component: Declined,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof Declined>;

export const Default: Story = {};
