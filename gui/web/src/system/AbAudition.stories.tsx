import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { AbAudition, type AbAuditionProps } from "./AbAudition";

function Controlled(args: AbAuditionProps) {
  const [side, setSide] = useState(args.side);
  return (
    <AbAudition
      {...args}
      side={side}
      onSelect={(next, segments) => {
        setSide(next);
        args.onSelect(next, segments);
      }}
    />
  );
}

const meta: Meta<typeof AbAudition> = {
  title: "System/AbAudition",
  component: AbAudition,
  tags: ["autodocs"],
  args: {
    side: "B",
    change: { start: 1114, end: 1115 },
    onSelect: fn(),
  },
  render: (args) => <Controlled {...args} />,
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
          "A two-segment control: A is before, B is after. Review plays 3 s before the change through 3 s after: A plays the original across the change, B plays the lead-in then the lead-out with the change left out. Moving a waveform handle switches it to B, so the next play is the adjusted result. Keys A and B come from the verb table.\n\n**Motion.** Animations come later.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof AbAudition>;

export const AfterSelected: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "B" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(canvas.getByRole("button", { name: "A" }));
    await expect(args.onSelect).toHaveBeenLastCalledWith("A", [
      { start: 1111, end: 1118 },
    ]);
    await expect(canvas.getByRole("button", { name: "A" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

export const BeforeSelected: Story = { args: { side: "A" } };

export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "A" }),
    ).toBeDisabled();
  },
};

export const Phone: Story = {};
