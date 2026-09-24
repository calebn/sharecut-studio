import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ToggleButton } from "./index";

const meta: Meta<typeof ToggleButton> = {
  title: "Atoms/ToggleButton",
  component: ToggleButton,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof ToggleButton>;

function Interactive(args: { quiet?: boolean }) {
  const [pressed, setPressed] = useState(false);
  return (
    <ToggleButton
      pressed={pressed}
      quiet={args.quiet}
      onClick={() => setPressed((p) => !p)}
    >
      {pressed ? "On" : "Off"}
    </ToggleButton>
  );
}

export const Interactive_: Story = {
  render: (args) => <Interactive {...args} />,
};

export const Quiet: Story = {
  render: () => <Interactive quiet />,
};

export const Pressed: Story = {
  args: { pressed: true, children: "Active filter" },
};

export const AllStates: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--space-3)" }}>
      <ToggleButton pressed={false}>Off</ToggleButton>
      <ToggleButton pressed>On</ToggleButton>
      <ToggleButton pressed={false} quiet>
        Quiet off
      </ToggleButton>
      <ToggleButton pressed quiet>
        Quiet on
      </ToggleButton>
    </div>
  ),
};
