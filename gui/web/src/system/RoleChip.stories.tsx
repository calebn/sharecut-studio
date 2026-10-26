import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { RoleChip } from "./RoleChip";

const meta: Meta<typeof RoleChip> = {
  title: "System/RoleChip",
  component: RoleChip,
  tags: ["autodocs"],
  args: { access: "viewer" },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "What a link lets someone do: listen (`ear`), comment (`message-square`) or edit (the Edit stage icon). Icon only on phone, with the role as its accessible name.\n\n**Motion.** Animations come later.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof RoleChip>;

export const Viewer: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("img", { name: "Viewer: can listen" }),
    ).toBeInTheDocument();
  },
};

export const Commenter: Story = { args: { access: "commenter" } };

export const Editor: Story = { args: { access: "editor" } };

export const Compact: Story = {
  args: { access: "commenter", compact: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("img", {
        name: "Commenter: can comment",
      }),
    ).toBeInTheDocument();
    await expect(within(canvasElement).queryByText("Commenter")).toBeNull();
  },
};
