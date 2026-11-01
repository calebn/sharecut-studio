import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { VOICE_PEAKS } from "./prepareFixtures";
import { SessionGroup, type SessionGroupProps } from "./SessionGroup";
import { SourceCard } from "./SourceCard";

const meta: Meta<typeof SessionGroup> = {
  title: "System/SessionGroup",
  component: SessionGroup,
  tags: ["autodocs"],
  args: {
    title: "Session 1",
    people: 3,
    takes: 2,
    duration: "14:20",
    target: "start",
    status: "idle",
    handoff: {
      stage: "edit",
      label: "Open in Edit",
      onActivate: fn(),
    },
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxInlineSize: "40rem" }}>
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
          'A group of takes recorded together. The header carries the numbers ("3 people · 2 takes · 14:20", wrapping, never cut), where the session goes, and how far transcription has got as a ring with words. While it runs the status is a progressbar with "Transcribing, 40%". The footer hands off to the next stage: secondary until the work is done, then primary; full width on a phone. A stage that owns the one hand-off (Prepare) omits `handoff` and the footer goes.\n\n**Motion.** None.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SessionGroup>;

function Takes() {
  const [a, setA] = useState("Maya");
  const [b, setB] = useState("Anneke");
  const common = {
    peaks: VOICE_PEAKS,
    state: "ready" as const,
    onRemove: fn(),
  };
  return (
    <>
      <SourceCard
        {...common}
        index={1}
        name={a}
        onName={setA}
        fileName="maya.wav"
        audioTime="7:02 of audio"
      />
      <SourceCard
        {...common}
        index={2}
        name={b}
        onName={setB}
        fileName="anneke.wav"
        audioTime="7:18 of audio"
      />
    </>
  );
}

const withTakes = (args: SessionGroupProps) => (
  <SessionGroup {...args}>
    <Takes />
  </SessionGroup>
);

export const Waiting: Story = {
  render: withTakes,
  args: {
    handoff: {
      stage: "edit",
      label: "Open in Edit",
      onActivate: fn(),
      disabledReason: "Transcribe first.",
    },
  },
};

export const NewAudio: Story = {
  render: withTakes,
  args: { status: "new" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("New audio waiting"),
    ).toBeVisible();
  },
};

export const Running: Story = {
  render: withTakes,
  args: {
    status: "running",
    progress: 0.4,
    handoff: {
      stage: "edit",
      label: "Open in Edit",
      onActivate: fn(),
      disabledReason: "Wait for the transcript.",
    },
  },
  play: async ({ canvasElement }) => {
    const bar = within(canvasElement).getByRole("progressbar");
    await expect(bar).toHaveAttribute("aria-valuenow", "40");
    await expect(bar).toHaveAttribute("aria-valuetext", "Transcribing, 40%");
  },
};

export const Done: Story = {
  render: withTakes,
  args: { status: "done", progress: 1, targetLocked: true },
};

export const Failed: Story = {
  render: withTakes,
  args: {
    status: "failed",
    handoff: {
      stage: "edit",
      label: "Open in Edit",
      onActivate: fn(),
      disabledReason: "Fix the failed take first.",
    },
  },
};

export const Empty: Story = {
  args: {
    people: 0,
    takes: 0,
    duration: "0:00",
    handoff: {
      stage: "edit",
      label: "Open in Edit",
      onActivate: fn(),
      disabledReason: "Add audio first.",
    },
  },
};

export const NoHandoff: Story = {
  render: withTakes,
  args: { status: "running", progress: 0.4, handoff: undefined },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByRole("button", { name: "Open in Edit" }),
    ).toBeNull();
  },
};

export const Phone: Story = {
  render: withTakes,
  args: { status: "running", progress: 0.4, targetLocked: true },
  globals: { viewport: { value: "mobile360", isRotated: false } },
};
