import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CSSProperties } from "react";
import { expect, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { ReadoutChip } from "./ReadoutChip";

const meta: Meta<typeof ReadoutChip> = {
  title: "System/ReadoutChip",
  component: ReadoutChip,
  tags: ["autodocs"],
  args: { delta: "−120 ms", value: "12:04.340" },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "A 22 px chip that floats 12 px above the pointer during any drag and says the change and the result (design-system element 12): clip trim, fade, move and roll, envelope points, levels, marker drags and the Decision card handles. The caller formats both strings and passes the pointer position; without a position the chip sits in the flow, as in these stories. Under a coarse pointer it rides 48 px above the finger so the thumb does not hide it. At the end of what the drag may do it adds a `limit` tag, so the stop is not told by colour alone. The control being dragged announces the value to assistive tech, so the chip is hidden from it.\n\n**Motion.** None. The chip appears with the drag, follows the pointer without easing and goes with the release.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ReadoutChip>;

export const DeltaAndValue: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("12:04.340")).toBeVisible();
    await expect(within(canvasElement).getByText("−120 ms")).toBeVisible();
  },
};

export const ValueOnly: Story = {
  args: { delta: undefined, value: "−3.0 dB" },
};

export const AtLimit: Story = {
  args: { delta: "+500 ms", value: "500 ms", atLimit: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("limit")).toBeVisible();
  },
};

const lane: CSSProperties = {
  position: "relative",
  blockSize: "6rem",
  marginBlockStart: "var(--space-8)",
  border: "1px solid var(--color-border-strong)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-bg-raised)",
};

const pointer: CSSProperties = {
  position: "absolute",
  insetInlineStart: "10rem",
  insetBlockStart: "3.5rem",
  inlineSize: "0.75rem",
  blockSize: "0.75rem",
  translate: "-50% -50%",
  clipPath: "circle(50%)",
  background: "var(--color-text-primary)",
};

export const OverALane: Story = {
  render: (args) => (
    <div style={lane}>
      <span style={pointer} />
      <ReadoutChip {...args} at={{ x: 160, y: 56 }} />
    </div>
  ),
};

export const PhoneOverALane: Story = {
  render: (args) => (
    <div style={{ inlineSize: "calc(22.5rem - 2 * var(--space-5))" }}>
      <div style={lane}>
        <span style={pointer} />
        <ReadoutChip {...args} at={{ x: 160, y: 56 }} />
      </div>
    </div>
  ),
};
