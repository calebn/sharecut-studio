import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { DropOverlay } from "./DropOverlay";

const meta: Meta<typeof DropOverlay> = {
  title: "System/DropOverlay",
  component: DropOverlay,
  tags: ["autodocs"],
  args: { label: "New tracks" },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)" }}>
        <p>The page underneath stays readable and keeps its focus.</p>
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
          "A full-window frame while files are dragged, labelled with the outcome of the current target. It is hidden from assistive technology, ignores the pointer and takes no focus; the label sits on an opaque panel so contrast never depends on what is underneath. The page announces the outcome in its own live region.\n\n**Motion.** The frame fades in with `--motion-state`. Not implemented in this slice.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof DropOverlay>;

export const NewTracks: Story = {
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".sys-drop")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  },
};
export const OverSource: Story = { args: { label: "Replace Maya's audio" } };
