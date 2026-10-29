import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { RoomStatusPill } from "./RoomStatusPill";

const meta: Meta<typeof RoomStatusPill> = {
  title: "System/RoomStatusPill",
  component: RoomStatusPill,
  tags: ["autodocs"],
  args: { phase: { kind: "waiting", host: "Maya" } },
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
          "What the room is doing, in one status pill, the same for every role and place. Capture health (mic lost, no audio) is on a person's tile and in the alert slot, so the pill only says waiting, counting in, live with the take clock, paused, saving, saved or reconnecting. The compact form is the Stage bar's badge: the clock alone while live, \"Paused\" without it. Paused shares the hollow glyph with waiting; the word tells them apart.\n\n**Motion.** Later: a turning saving ring. The clock text changes without animation.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof RoomStatusPill>;

export const Waiting: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Waiting for Maya to start"),
    ).toBeInTheDocument();
  },
};
export const Countdown: Story = {
  args: { phase: { kind: "countdown", secondsLeft: 3 } },
};
export const Live: Story = {
  args: { phase: { kind: "live", take: 2, clockSec: 724 } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("12:04 · Take 2"),
    ).toBeInTheDocument();
  },
};
export const Paused: Story = {
  args: { phase: { kind: "paused", clockSec: 724 } },
};
export const Saving: Story = {
  args: { phase: { kind: "saving", savedPeople: 2, totalPeople: 3 } },
};
export const Saved: Story = { args: { phase: { kind: "saved" } } };
export const Reconnecting: Story = {
  args: { phase: { kind: "reconnecting" } },
};
export const Compact: Story = {
  args: { phase: { kind: "live", take: 2, clockSec: 724 }, compact: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("12:04")).toBeInTheDocument();
  },
};
