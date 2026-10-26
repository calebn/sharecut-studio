import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { StatusPill } from "./StatusPill";

const meta: Meta<typeof StatusPill> = {
  title: "System/StatusPill",
  component: StatusPill,
  tags: ["autodocs"],
  args: { state: "done", text: "Edited" },
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
          'A short persistent state: a status glyph and a few words, 28 px. The glyph shape differs per state, and its name is read aloud, so colour is never the only cue. It names where a Project card opens ("Review 6").\n\n**Motion.** The text swaps without animation; a running glyph turns with `--motion-loop-pipeline`.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof StatusPill>;

export const Done: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Edited")).toBeInTheDocument();
    await expect(canvas.getByText("Done")).toBeInTheDocument();
  },
};
export const Running: Story = {
  args: { state: "running", text: "Processing 40%", progress: 0.4 },
};
export const NeedsYou: Story = {
  args: { state: "needs-you", text: "Review 6" },
};
export const Failed: Story = {
  args: { state: "failed", text: "Upload stopped" },
};
export const Live: Story = {
  args: { state: "live", text: "Recording" },
};
export const Offline: Story = {
  args: { state: "offline", text: "Reconnecting…" },
};
