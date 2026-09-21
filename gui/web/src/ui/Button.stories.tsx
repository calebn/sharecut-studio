import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, type ButtonVariant } from "./index";

const meta: Meta<typeof Button> = {
  title: "Atoms/Button",
  component: Button,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: [
        "default",
        "primary",
        "danger",
        "link",
      ] satisfies ButtonVariant[],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Default: Story = { args: { children: "Button" } };

export const Primary: Story = {
  args: { variant: "primary", children: "Save changes" },
};

export const Danger: Story = {
  args: { variant: "danger", children: "Delete" },
};

export const Link: Story = {
  args: { variant: "link", children: "Learn more" },
};

export const Disabled: Story = {
  args: { disabled: true, children: "Unavailable" },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
      <Button>Default</Button>
      <Button variant="primary">Primary</Button>
      <Button variant="danger">Danger</Button>
      <Button variant="link">Link</Button>
      <Button disabled>Disabled</Button>
    </div>
  ),
};
