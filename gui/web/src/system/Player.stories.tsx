import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import type { OverviewTick } from "./OverviewStrip";
import { Player, type PlayerProps } from "./Player";

const peaks = Array.from(
  { length: 64 },
  (_, i) => 0.2 + 0.7 * Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.23)),
);
const ticks: OverviewTick[] = [
  { at: 0.3, kind: "comment" },
  { at: 0.5, kind: "chapter" },
  { at: 0.75, kind: "chapter" },
];
const chapters = [
  { title: "Cold open", time: "0:00", at: 0 },
  { title: "The long way round", time: "26:05", at: 0.5 },
  { title: "Listener mail", time: "39:08", at: 0.75 },
];

const meta: Meta<typeof Player> = {
  title: "System/Player",
  component: Player,
  tags: ["autodocs"],
  args: {
    form: "bar",
    playing: false,
    time: "12:04",
    total: "52:10",
    title: "Episode 14",
    chapters,
    chapter: 0,
    peaks,
    ticks,
    playhead: 0.23,
    onPlayPause: fn(),
    onSkip: fn(),
    onHearOriginal: fn(),
    onComment: fn(),
    onExpand: fn(),
    onCollapse: fn(),
    onRetry: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ paddingBlockStart: "1rem" }}>
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
          "Bar form: 56 px on every device. Time and cuts on the left, back 15 s, Play and forward 15 s in the center, A/B and Comment on the right. Play is ink-filled, not accent. Below a 40rem container the skip buttons, the total and the extra pills hide. The expanded form adds a 64 px Overview strip, a 64 px Play and the chapter list; on phone a host shows it in a Sheet.\n\n**Motion.** The expanded form rises with `--motion-panel` and the Play icon swaps with `--motion-toggle` in the animation pass. The loading ring is static here.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Player>;

export const Ready: Story = {};
export const Playing: Story = { args: { playing: true } };
export const WithCuts: Story = { args: { cuts: "−4:10" } };
export const HearOriginalHeld: Story = {
  args: { hearOriginal: true, cuts: "−4:10" },
};
export const Loading: Story = { args: { state: "loading" } };
export const MixUpdating: Story = {
  args: { state: "mix-updating", cuts: "−4:10" },
};
export const AudioError: Story = { args: { state: "error" } };
export const Soloed: Story = { args: { solo: "Rosa", playing: true } };
export const Following: Story = {
  args: { following: { name: "Rosa", colorIndex: 1 }, playing: true },
};

function Toggling(args: PlayerProps) {
  const [expanded, setExpanded] = useState(false);
  const [playing, setPlaying] = useState(false);
  return (
    <Player
      {...args}
      form={expanded ? "expanded" : "bar"}
      playing={playing}
      onPlayPause={() => setPlaying((value) => !value)}
      onExpand={() => setExpanded(true)}
      onCollapse={() => setExpanded(false)}
    />
  );
}

export const Phone: Story = {
  render: (args) => <Toggling {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Play" }));
    await expect(canvas.getByRole("button", { name: "Pause" })).toBeVisible();
  },
};

export const Expanded: Story = {
  render: (args) => <Toggling {...args} />,
  args: { cuts: "−4:10" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: /Expand player/ }),
    );
    await expect(canvas.getByRole("list", { name: "Chapters" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Collapse" }));
    await expect(canvas.queryByRole("list", { name: "Chapters" })).toBeNull();
    await userEvent.click(
      canvas.getByRole("button", { name: /Expand player/ }),
    );
  },
};

export const ExpandedGuest: Story = {
  args: { form: "expanded", guest: true, playing: true },
};
