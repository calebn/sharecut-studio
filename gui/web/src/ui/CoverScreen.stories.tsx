import type { Meta, StoryObj } from "@storybook/react-vite";
import { CoverScreen } from "./CoverScreen";

const meta: Meta<typeof CoverScreen> = {
  title: "Templates/CoverScreen",
  component: CoverScreen,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof CoverScreen>;

export const WithHeading: Story = {
  args: {
    heading: "Room full",
    children: <p>Ask the host for a new room link.</p>,
  },
};

export const StatusOnly: Story = {
  args: { children: <p>Loading studio…</p> },
};
