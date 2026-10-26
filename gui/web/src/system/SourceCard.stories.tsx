import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { VOICE_PEAKS } from "./prepareFixtures";
import { SourceCard, type SourceCardProps } from "./SourceCard";

const meta: Meta<typeof SourceCard> = {
  title: "System/SourceCard",
  component: SourceCard,
  tags: ["autodocs"],
  args: {
    state: "ready",
    index: 2,
    name: "",
    onName: fn(),
    fileName: "interview-track-2.wav",
    audioTime: "5:11 of audio",
    peaks: VOICE_PEAKS,
    onHear: fn(),
    onSplit: fn(),
    onRemove: fn(),
    onReplace: fn(),
    onMerge: fn(),
    onRetry: fn(),
    onDetails: fn(),
    onVoices: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxInlineSize: "32rem" }}>
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
          'One uploaded voice track, as a section. Its controls are separate tab stops in reading order: the speaker name, Hear, Remove and More. A card that sounds like several people asks "One recording of several people?" and adds the voice count (2 to 8, with the reason shown at each limit) and Split (`canSplit`, on by default only for that state). Remove, Split, Fewer and More voices, Speaker name, Try again, Details, Cancel splitting, Replace audio and Move carry the card name for assistive tech ("Remove Maya"). More holds Replace audio, Merge, and Move up and Move down, the keyboard way to reorder tracks. While `splitting` the card shows progress with Cancel splitting. Hear reads "Hear voice 2" until the voice is named, then "Hear Maya". Time reads "5:11 of audio", never a share. The status line says what is happening in words: Uploading, Checking file, Ready, Needs a name, or the plain cause of a failure.\n\n**Motion.** None.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SourceCard>;

function Live(props: SourceCardProps) {
  const [name, setName] = useState(props.name);
  const [voices, setVoices] = useState(props.voices ?? 2);
  return (
    <SourceCard
      {...props}
      name={name}
      onName={setName}
      voices={voices}
      onVoices={setVoices}
    />
  );
}

export const NeedsName: Story = {
  args: { state: "needs-name" },
  render: (args) => <Live {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Needs a name")).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Hear voice 2" }),
    ).toBeVisible();
    await userEvent.type(canvas.getByLabelText(/^Speaker name/), "Maya");
    await expect(
      canvas.getByRole("button", { name: "Hear Maya" }),
    ).toBeVisible();
  },
};

export const Ready: Story = {
  args: { state: "ready", name: "Maya" },
  render: (args) => <Live {...args} />,
};

export const Playing: Story = {
  args: { state: "ready", name: "Maya", playing: true },
  render: (args) => <Live {...args} />,
};

export const Uploading: Story = {
  args: { state: "uploading", progress: 0.4, name: "" },
  render: (args) => <Live {...args} />,
};

export const Probing: Story = {
  args: { state: "probing", name: "" },
  render: (args) => <Live {...args} />,
};

export const Failed: Story = {
  args: {
    state: "failed",
    cause: "This file has no audio in it.",
    name: "",
  },
  render: (args) => <Live {...args} />,
};

export const SplitPrompt: Story = {
  args: { state: "split-prompt", name: "Track 1", voices: 3 },
  render: (args) => <Live {...args} />,
};

export const StepperLimits: Story = {
  args: { state: "split-prompt", name: "Maya", voices: 8 },
  render: (args) => <Live {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Eight is the most")).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: /^More voices/ }),
    ).toHaveAttribute("aria-disabled", "true");
  },
};

export const ReadyCanSplit: Story = {
  args: { state: "ready", name: "Maya", voices: 3, canSplit: true },
  render: (args) => <Live {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Split Maya" }),
    ).toBeVisible();
  },
};

export const Splitting: Story = {
  args: {
    state: "splitting",
    name: "Track 1",
    progress: 0.4,
    splitDetail: "1 of 3 voices",
    onCancelSplit: fn(),
  },
  render: (args) => <Live {...args} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("progressbar", { name: "Finding voices" }),
    ).toHaveAttribute("aria-valuenow", "40");
    await userEvent.click(
      canvas.getByRole("button", { name: /^Cancel splitting/ }),
    );
    await expect(args.onCancelSplit).toHaveBeenCalledOnce();
  },
};

export const MoveInMenu: Story = {
  args: {
    state: "ready",
    name: "Maya",
    onMoveUp: fn(),
    onMoveDown: fn(),
  },
  render: (args) => <Live {...args} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "More for Maya" }),
    );
    await userEvent.click(
      within(canvasElement.ownerDocument.body).getByRole("menuitem", {
        name: "Move up for Maya",
      }),
    );
    await expect(args.onMoveUp).toHaveBeenCalledOnce();
  },
};

export const SameName: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      <Live
        {...(meta.args as SourceCardProps)}
        index={1}
        name="Sam"
        sameNameAs="Sam"
        audioTime="5:11 of audio"
      />
      <Live
        {...(meta.args as SourceCardProps)}
        index={2}
        name="Sam"
        sameNameAs="Sam"
        audioTime="2:40 of audio"
      />
    </div>
  ),
};

export const Phone: Story = {
  args: { state: "needs-name" },
  render: (args) => <Live {...args} />,
  globals: { viewport: { value: "mobile360", isRotated: false } },
};
