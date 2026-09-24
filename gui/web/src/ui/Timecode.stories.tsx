import type { Meta, StoryObj } from "@storybook/react-vite";
import { Timecode } from "./index";

const meta: Meta<typeof Timecode> = {
  title: "Atoms/Timecode",
  component: Timecode,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof Timecode>;

export const Default: Story = {
  args: {
    current: "00:12.480",
    total: "01:00.000",
    title: "00:12.480 / 01:00.000",
  },
};

export const Compact: Story = {
  args: { current: "00:12.480", title: "00:12.480 / 01:00.000" },
};

export const Hours: Story = {
  args: {
    current: "01:02:03.450",
    total: "01:45:00.000",
    hours: true,
    title: "01:02:03.450 / 01:45:00.000",
  },
};
