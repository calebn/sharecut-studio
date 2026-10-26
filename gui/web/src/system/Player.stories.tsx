import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
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
    onChapter: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ paddingBlockStart: "var(--space-5)" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "Bar form: 56 px on every device. Time and cuts on the left, back 15 s, Play and forward 15 s in the center, then A/B, Comment and the Status pills (following, solo, mix, audio error) on the right. A/B is the segmented control: A is the original, B the edit. Play is ink-filled, not accent. Below a 40rem container the skip buttons and the total hide and each Status pill shows its glyph only; the text stays for assistive tech. The expanded form adds a 64 px Overview strip, a 64 px Play and the chapter list; on phone a host shows it in a Sheet.\n\n**Motion.** The expanded form rises with `--motion-panel` and the Play icon swaps with `--motion-toggle` in the animation pass. The loading ring is static here.",
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
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const original = canvas.getByRole("button", { name: "A" });
    await expect(original).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByRole("button", { name: "B" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await userEvent.click(canvas.getByRole("button", { name: "B" }));
    await expect(args.onHearOriginal).toHaveBeenCalledWith(false);
  },
};
export const HearMenu: Story = {
  args: { hearMenu: { mode: "mix", onMode: fn() } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.pointer({
      keys: "[MouseRight]",
      target: canvas.getByRole("group", { name: "Audition" }),
    });
    const body = within(document.body);
    await expect(
      await body.findByRole("menuitemradio", { name: "Full mix" }),
    ).toHaveAttribute("aria-checked", "true");
    await userEvent.click(
      body.getByRole("menuitemradio", { name: "Original" }),
    );
    await expect(args.hearMenu?.onMode).toHaveBeenCalledWith("original");
  },
};
export const Loading: Story = { args: { state: "loading" } };
export const MixUpdating: Story = {
  args: { state: "mix-updating", cuts: "−4:10" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Updating mix")).toBeVisible();
  },
};
export const AudioError: Story = {
  args: { state: "error" },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Audio error")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(args.onRetry).toHaveBeenCalledOnce();
  },
};
export const Soloed: Story = {
  args: { solo: "Rosa", playing: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Solo Rosa"),
    ).toBeInTheDocument();
  },
};
export const Following: Story = {
  args: {
    following: { name: "Rosa", colorIndex: 1 },
    playing: true,
    onUnfollow: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Following Rosa")).toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole("button", { name: "Stop following Rosa" }),
    );
    await expect(args.onUnfollow).toHaveBeenCalledOnce();
  },
};

function Toggling({
  initialExpanded = false,
  ...args
}: PlayerProps & { initialExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(initialExpanded);
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

/** Starts expanded, collapses to the bar, and expands again: it ends expanded on purpose, for the sweep and the screenshot. */
export const Expanded: Story = {
  render: (args) => <Toggling {...args} initialExpanded />,
  args: { cuts: "−4:10" },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("list", { name: "Chapters" })).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: /The long way round/ }),
    );
    await expect(args.onChapter).toHaveBeenCalledWith(1);
    await userEvent.click(
      canvas.getByRole("button", { name: "Collapse player" }),
    );
    await expect(canvas.queryByRole("list", { name: "Chapters" })).toBeNull();
    const expand = canvas.getByRole("button", { name: /Expand player/ });
    await expect(expand).toHaveFocus();
    await userEvent.click(expand);
    await expect(canvas.getByRole("list", { name: "Chapters" })).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Collapse player" }),
    ).toHaveFocus();
  },
};

export const ExpandedGuest: Story = {
  args: { form: "expanded", guest: true, playing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: "A" })).toBeNull();
    await expect(canvas.getByRole("button", { name: "Comment" })).toBeVisible();
  },
};

export const ExpandedAudioError: Story = {
  args: { form: "expanded", state: "error" },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Audio error")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(args.onRetry).toHaveBeenCalledOnce();
  },
};
