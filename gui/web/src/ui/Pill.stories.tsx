import type { Meta, StoryObj } from "@storybook/react-vite";
import { Pill } from "./index";

const meta: Meta<typeof Pill> = {
  title: "Atoms/Pill",
  component: Pill,
  tags: ["autodocs"],
  argTypes: {
    tone: {
      control: "select",
      options: ["neutral", "ok", "warning", "audition"],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Pill>;

export const Ok: Story = { args: { tone: "ok", children: "Fresh" } };

export const Warning: Story = {
  args: { tone: "warning", children: "Importing…" },
};

export const AllTones: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--space-3)" }}>
      <Pill>Neutral</Pill>
      <Pill tone="ok">Fresh</Pill>
      <Pill tone="warning">No preview</Pill>
      <Pill tone="audition">Region 12.0–18.5s</Pill>
    </div>
  ),
};
