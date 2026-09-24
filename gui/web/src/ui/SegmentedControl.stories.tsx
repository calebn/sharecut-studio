import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { SegmentedControl, ToggleButton } from "./index";

const MODES = [
  { id: "mix", label: "Mix" },
  { id: "fx", label: "FX" },
  { id: "raw", label: "Raw" },
] as const;

const meta: Meta<typeof SegmentedControl> = {
  title: "Molecules/SegmentedControl",
  component: SegmentedControl,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof SegmentedControl>;

function Modes({ disabled }: { disabled?: string }) {
  const [mode, setMode] = useState<string>("mix");
  return (
    <SegmentedControl label="Audition mode">
      {MODES.map((m) => (
        <ToggleButton
          key={m.id}
          quiet
          pressed={mode === m.id}
          disabled={disabled === m.id}
          onClick={() => setMode(m.id)}
        >
          {m.label}
        </ToggleButton>
      ))}
    </SegmentedControl>
  );
}

export const Default: Story = {
  render: () => <Modes />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "FX" }));
    await expect(canvas.getByRole("button", { name: "FX" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(canvas.getByRole("button", { name: "Mix" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  },
};

export const WithDisabledSegment: Story = {
  render: () => <Modes disabled="raw" />,
};
