import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { JoinBadgeView } from "./JoinBadge";
import { timelineLaneStoryDecorator } from "./timelineLaneStoryDecorator";

const meta: Meta<typeof JoinBadgeView> = {
  title: "Templates/JoinBadge",
  component: JoinBadgeView,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen", lanePreviewLabel: "Join badge preview" },
  decorators: [timelineLaneStoryDecorator],
  args: {
    glyph: "fade",
    blocked: false,
    seamSec: 4,
    zoomPxPerSec: 40,
    expanded: false,
    onClick: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof JoinBadgeView>;

export const Cut: Story = { args: { glyph: "cut" } };

export const Fade: Story = {};

export const Crossfade: Story = { args: { glyph: "crossfade" } };

/** A crossfade render cannot blend: warning border, ", will not blend" in the name. */
export const BlockedCrossfade: Story = {
  args: { glyph: "crossfade", blocked: true },
};

/** All four side by side at lane scale, to compare the glyphs. */
export const AllGlyphs: Story = {
  render: () => (
    <>
      <JoinBadgeView
        glyph="cut"
        blocked={false}
        seamSec={2}
        zoomPxPerSec={40}
        expanded={false}
        onClick={() => undefined}
      />
      <JoinBadgeView
        glyph="fade"
        blocked={false}
        seamSec={5}
        zoomPxPerSec={40}
        expanded={false}
        onClick={() => undefined}
      />
      <JoinBadgeView
        glyph="crossfade"
        blocked={false}
        seamSec={8}
        zoomPxPerSec={40}
        expanded={false}
        onClick={() => undefined}
      />
      <JoinBadgeView
        glyph="crossfade"
        blocked
        seamSec={11}
        zoomPxPerSec={40}
        expanded={false}
        onClick={() => undefined}
      />
    </>
  ),
};
