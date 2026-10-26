import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { SaveIndicator } from "./SaveIndicator";

const meta: Meta<typeof SaveIndicator> = {
  title: "System/SaveIndicator",
  component: SaveIndicator,
  tags: ["autodocs"],
  args: { state: "saved", onRetry: fn(), onDownload: fn() },
  decorators: [
    (Story) => (
      <div style={{ padding: "1rem" }}>
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
          "A small glyph after the title. Saved shows nothing, or a check for 2 s after a save. Saving is a hollow ring, Offline an amber cloud with a count, Failed a red octagon with Retry and Download a copy. Every state also has a text name for assistive tech.\n\n**Motion.** The check fades out after 2 s with `--motion-state` in the animation pass; the 2 s hold is the caller's.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SaveIndicator>;

export const Saved: Story = {};
export const JustSaved: Story = { args: { justSaved: true } };
export const Saving: Story = { args: { state: "saving" } };
export const Offline: Story = { args: { state: "offline", waiting: 2 } };
export const Failed: Story = { args: { state: "failed" } };
export const FailedCompact: Story = {
  args: { state: "failed", compact: true },
};
