import type { Meta, StoryObj } from "@storybook/react-vite";
import { BrandLockup, BrandSymbol } from "./index";

const meta = {
  title: "Atoms/BrandMark",
  component: BrandLockup,
  args: { name: "ShareCut Studio" },
} satisfies Meta<typeof BrandLockup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Lockup: Story = {};

export const Symbol: Story = {
  render: () => <BrandSymbol />,
};
