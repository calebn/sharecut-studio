import type { Meta, StoryObj } from "@storybook/react-vite";
import { Field } from "./index";

const meta: Meta<typeof Field> = {
  title: "Molecules/Field",
  component: Field,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof Field>;

export const Default: Story = {
  args: {
    label: "Episode title",
    htmlFor: "sb-title",
    children: <input id="sb-title" defaultValue="Morning coffee chat" />,
  },
};

export const WithHint: Story = {
  args: {
    label: "Export filename",
    htmlFor: "sb-filename",
    hint: "Used for the downloadable file; spaces become dashes.",
    hintId: "sb-filename-hint",
    children: (
      <input
        id="sb-filename"
        aria-describedby="sb-filename-hint"
        defaultValue="episode-12"
      />
    ),
  },
};

export const WithError: Story = {
  args: {
    label: "Share link expiry",
    htmlFor: "sb-expiry",
    error: "Expiry must be a future date.",
    errorId: "sb-expiry-error",
    children: (
      <input
        id="sb-expiry"
        aria-describedby="sb-expiry-error"
        aria-invalid
        defaultValue="2020-01-01"
      />
    ),
  },
};
