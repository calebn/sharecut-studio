import type { Meta, StoryObj } from "@storybook/react-vite";
import { Icon, type IconName } from "./index";

const NAMES: IconName[] = [
  "select",
  "blade",
  "comment",
  "fit",
  "menu",
  "cutAtPlayhead",
  "agent",
];

const meta: Meta<typeof Icon> = {
  title: "Atoms/Icon",
  component: Icon,
  tags: ["autodocs"],
  argTypes: {
    name: { control: "select", options: NAMES },
    size: { control: { type: "number", min: 12, max: 48, step: 2 } },
  },
};

export default meta;
type Story = StoryObj<typeof Icon>;

export const Default: Story = { args: { name: "blade", title: "Blade" } };

export const AllIcons: Story = {
  render: () => (
    <div
      style={{
        display: "flex",
        gap: "var(--space-3)",
        alignItems: "center",
        color: "var(--color-text-primary)",
      }}
    >
      {NAMES.map((name) => (
        <span
          key={name}
          style={{
            display: "inline-flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "var(--space-1)",
          }}
        >
          <Icon name={name} size={20} />
          <small style={{ color: "var(--color-text-secondary)" }}>{name}</small>
        </span>
      ))}
    </div>
  ),
};
