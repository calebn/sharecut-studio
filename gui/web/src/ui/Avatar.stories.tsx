import type { Meta, StoryObj } from "@storybook/react-vite";
import { Avatar } from "./index";

const meta: Meta<typeof Avatar> = {
  title: "Atoms/Avatar",
  component: Avatar,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof Avatar>;

export const Default: Story = { args: { name: "Ada Lovelace" } };

export const Sizes: Story = {
  render: () => (
    <div
      style={{
        display: "flex",
        gap: "var(--space-2)",
        alignItems: "center",
      }}
    >
      <Avatar name="Ada Lovelace" size="sm" />
      <Avatar name="Ada Lovelace" size="md" />
    </div>
  ),
};

export const WithBadge: Story = {
  args: { name: "Grace Hopper", badge: 3, ring: "solid" },
};
