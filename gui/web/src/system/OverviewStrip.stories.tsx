import type { Meta, StoryObj } from "@storybook/react-vite";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { OverviewStrip, type OverviewTick } from "./OverviewStrip";

const peaks = Array.from(
  { length: 64 },
  (_, i) => 0.2 + 0.7 * Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.23)),
);

const ticks: OverviewTick[] = [
  { at: 0.12, kind: "suggestion" },
  { at: 0.3, kind: "comment" },
  { at: 0.44, kind: "find" },
  { at: 0.5, kind: "chapter" },
  { at: 0.71, kind: "suggestion", current: true },
  { at: 0.86, kind: "comment" },
];

const meta: Meta<typeof OverviewStrip> = {
  title: "System/OverviewStrip",
  component: OverviewStrip,
  tags: ["autodocs"],
  args: { peaks, label: "Episode overview", playhead: 0.4 },
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
          "A whole-episode miniature with the playhead, viewport, selection band and ticks. Four heights: 16 (phone Edit), 32 (Review context), 48 (Project card, static), 64 (expanded Player).\n\n**Motion.** The playhead and viewport follow with no easing while playing; the viewport eases with `--motion-state` when it jumps. Not implemented in this slice.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof OverviewStrip>;

export const Edit16: Story = {
  args: { height: 16, viewport: [0.3, 0.55], selection: [0.34, 0.4] },
};
export const Review32: Story = { args: { height: 32, ticks } };
export const CardStatic48: Story = {
  args: { height: 48, playhead: undefined },
};
export const Player64: Story = { args: { height: 64, ticks } };
