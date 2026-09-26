import type { Meta, StoryObj } from "@storybook/react-vite";
import { ClipLed } from "./ClipLed";

const meta: Meta<typeof ClipLed> = {
  title: "Atoms/ClipLed",
  component: ClipLed,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof ClipLed>;

export const Idle: Story = { args: { lit: false, showText: true } };
export const Lit: Story = { args: { lit: true, showText: true } };
export const LabelledCompact: Story = { args: { lit: true, label: "Take" } };
