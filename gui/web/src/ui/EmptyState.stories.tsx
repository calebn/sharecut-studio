import type { Meta, StoryObj } from "@storybook/react-vite";
import { EmptyState, Field } from "./index";

const meta: Meta<typeof EmptyState> = {
  title: "Atoms/EmptyState",
  component: EmptyState,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof EmptyState>;

export const Default: Story = { args: { children: "No live review links." } };

/** Next to a real field, the empty state must not read as a disabled input. */
export const BesideAField: Story = {
  render: () => (
    <div
      style={{ display: "grid", gap: "var(--space-3)", maxInlineSize: "24rem" }}
    >
      <Field label="Anyone with the link" htmlFor="empty-state-story-role">
        <select id="empty-state-story-role" defaultValue="commenter">
          <option value="viewer">Viewer</option>
          <option value="commenter">Commenter</option>
        </select>
      </Field>
      <EmptyState>No live review links.</EmptyState>
    </div>
  ),
};
