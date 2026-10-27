import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { ScopeChip } from "./ScopeChip";

const tracks = [
  { id: "mira", name: "Mira", color: "var(--color-clip-dialogue-0)" },
  { id: "jonas", name: "Jonas", color: "var(--color-clip-dialogue-1)" },
  { id: "music", name: "Music", color: "var(--color-clip-music)" },
];

const meta: Meta<typeof ScopeChip> = {
  title: "System/ScopeChip",
  component: ScopeChip,
  tags: ["autodocs"],
  args: { tracks, all: false, ripple: true, onToggle: fn() },
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
          "The leading slot of the Action bar for words, ranges and Split: stacked track-colour dots, or All, then the ripple mark when time closes or the gap glyph when time is kept. A click toggles the tracks. Without `onToggle` it is a label, for a read-only guest. The ripple word is hidden under the dock and floating forms; the glyph stays.\n\n**Motion.** None.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ScopeChip>;

export const Ripple: Story = {
  play: async ({ args, canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button"));
    await expect(args.onToggle).toHaveBeenCalledOnce();
  },
};

export const Gap: Story = {
  args: { ripple: false },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("img", { name: "Leave gap" }),
    ).toBeVisible();
  },
};

export const AllTracks: Story = {
  args: { all: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("All")).toBeVisible();
  },
};

export const OneTrack: Story = { args: { tracks: tracks.slice(0, 1) } };

export const ReadOnly: Story = {
  args: { onToggle: undefined },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("button")).toBeNull();
  },
};
