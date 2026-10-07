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
    children: (control) => (
      <input {...control} defaultValue="Morning coffee chat" />
    ),
  },
};

export const WithHint: Story = {
  args: {
    label: "Export filename",
    hint: "Used for the downloadable file; spaces become dashes.",
    children: (control) => <input {...control} defaultValue="episode-12" />,
  },
};

export const WithError: Story = {
  args: {
    label: "Chapter start",
    error: "Start must fall inside the episode.",
    children: (control) => <input {...control} defaultValue="99:00" />,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Field describes the control by its error and marks it `aria-invalid`; the error is an `InlineError` alert.",
      },
    },
  },
};
