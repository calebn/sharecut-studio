import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { clipRow } from "../test/fixtures";
import { InspectorSeekFooterView } from "../ui/InspectorSeekFooterView";
import { JoinPopoverView } from "./JoinPopoverView";

const left = clipRow({
  id: "c0",
  source_start: 0,
  source_end: 5,
  timeline_start: 0,
  timeline_end: 5,
  fade_in_ms: 0,
  fade_out_ms: 10,
});
const right = clipRow({
  id: "c1",
  source_start: 5,
  source_end: 10,
  timeline_start: 5,
  timeline_end: 10,
  fade_in_ms: 10,
  join_left_clip_id: "c0",
  join_in_mode: "fade",
});

const meta: Meta<typeof JoinPopoverView> = {
  title: "Templates/JoinPopover",
  component: JoinPopoverView,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <main aria-label="Join popover preview">
        <Story />
      </main>
    ),
  ],
  args: {
    id: "join-popover-story",
    left,
    right,
    seamSec: 5,
    trackFadeMaxMs: 40,
    editable: true,
    busy: false,
    error: null,
    onModeChange: fn(),
    onLengthCommit: fn(),
    onClose: fn(),
    footer: (
      <InspectorSeekFooterView
        seekLabel="Seek join"
        playLabel="Audition join"
        onSeek={fn()}
        onPlay={fn()}
      />
    ),
  },
};

export default meta;
type Story = StoryObj<typeof JoinPopoverView>;

export const Fade: Story = {};

export const Crossfade: Story = {
  args: {
    right: clipRow({
      ...right,
      join_in_mode: "crossfade",
      join_crossfade_ms: 25,
      fade_in_ms: 25,
    }),
    left: clipRow({ ...left, fade_out_ms: 25 }),
  },
};

export const Cut: Story = {
  args: { right: clipRow({ ...right, join_in_mode: "cut" }) },
};

export const BlockedCrossfade: Story = {
  args: {
    right: clipRow({
      ...right,
      join_in_mode: "crossfade",
      join_crossfade_blocked: "no_fade_in",
    }),
  },
};

export const ReadOnly: Story = { args: { editable: false } };

export const BusyWithError: Story = {
  args: { busy: true, error: "Join could not be applied" },
};
