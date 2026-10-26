import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { RailLabelPeek } from "./RailLabelPeek";

const meta: Meta<typeof RailLabelPeek> = {
  title: "Templates/RailLabelPeek",
  component: RailLabelPeek,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ position: "relative", blockSize: "6rem" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof RailLabelPeek>;

export const Peek: Story = {
  args: { peek: { text: "Blade", centerX: 120, bottom: 24 } },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(".editing-tool-rail-peek"),
    ).toHaveTextContent("Blade");
  },
};

export const NearEdge: Story = {
  args: { peek: { text: "Select range", centerX: 6, bottom: 24 } },
};
