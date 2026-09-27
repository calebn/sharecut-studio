import type { Meta, StoryObj } from "@storybook/react-vite";
import { InlineError } from "./index";

const meta: Meta<typeof InlineError> = {
  title: "Atoms/InlineError",
  component: InlineError,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof InlineError>;

export const Default: Story = {
  args: { message: "That name is already taken." },
};

export const Empty: Story = {
  args: { message: null },
  parameters: {
    docs: {
      description: {
        story: "Renders nothing when the message is empty — no layout shift.",
      },
    },
  },
};

export const Inline: Story = {
  args: { message: "Text cannot be empty", inline: true, role: "alert" },
  parameters: {
    docs: {
      description: {
        story:
          "`inline` renders a `<span>` for use inside phrasing content (e.g. the transcript inline word editor); pair `id` with the control's `aria-describedby`.",
      },
    },
  },
};
