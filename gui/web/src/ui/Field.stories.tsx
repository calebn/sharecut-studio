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
    label: "Chapter start",
    htmlFor: "sb-chapter-start",
    error: "Start must fall inside the episode.",
    errorId: "sb-chapter-start-error",
    children: (
      <input
        id="sb-chapter-start"
        aria-describedby="sb-chapter-start-error"
        aria-invalid
        defaultValue="99:00"
      />
    ),
  },
};
