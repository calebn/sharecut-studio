import type { Meta, StoryObj } from "@storybook/react-vite";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { CoverScreen } from "./index";

const meta: Meta<typeof CoverScreen> = {
  title: "Organisms/CoverScreen",
  component: CoverScreen,
  tags: ["autodocs"],
  parameters: { ...isolatedStoryParameters, layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof CoverScreen>;

export const WithHeading: Story = {
  args: {
    heading: "Example heading",
    children: <p>Example body content.</p>,
  },
};

export const StatusOnly: Story = {
  args: { children: <p role="status">Loading…</p> },
};
