import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { fileDataTransfer, fireDrag } from "../storybook/storyPlay";
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
          'One uploaded voice track, as a section. Its controls are separate tab stops in reading order: the speaker name, Hear, Remove and More. A card that sounds like several people asks "One recording of several people?" and adds the voice count (a scrub field, 2 to 8, with a reset dot off 2) and Split (`canSplit`, on by default only for that state). Remove, Split, Number of voices, Speaker name, Try again, Details, Cancel splitting, Replace audio and Move carry the card name for assistive tech ("Remove Maya"). More holds Replace audio, Merge, and Move up and Move down, the keyboard way to reorder tracks. Dropping an audio file on a ready card replaces its audio at once (`onDropAudio`), with an Undo toast and no question; the stage labels the drop \"Replace Maya\'s audio\" (`onDropHover`). A grip at the start of the actions row drags the card to reorder it within its session (pointer only; `grip`). While `splitting` the card shows progress with Cancel splitting. Hear reads "Hear voice 2" until the voice is named, then "Hear Maya". Time reads "5:11 of audio", never a share. The status line says what is happening in words: Uploading, Checking file, Ready, Needs a name, or the plain cause of a failure.\n\n**Motion.** None.',
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

export const New: Story = {
  args: { state: "new", name: "Priya", audioTime: "14:11 of audio" },
  render: (args) => <Live {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("New")).toBeVisible();
    await expect(
      canvas.getByText("14:11 of audio · not processed yet"),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Hear Priya" }),
    ).toBeVisible();
  },
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

export const VoicesScrub: Story = {
  args: { state: "split-prompt", name: "Maya", voices: 8 },
  render: (args) => <Live {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const voices = canvas.getByRole("spinbutton", {
      name: "Number of voices for Maya",
    });
    await expect(voices).toHaveAttribute("aria-valuemax", "8");
    await userEvent.click(
      canvas.getByRole("button", { name: /^Reset Number of voices/ }),
    );
    await expect(voices).toHaveAttribute("aria-valuetext", "2 voices");
  },
};

export const ReplaceByDrop: Story = {
  args: { state: "ready", name: "Maya", onDropAudio: fn(), onDropHover: fn() },
  render: (args) => <Live {...args} />,
  play: async ({ args, canvasElement }) => {
    const card = within(canvasElement).getByRole("region", {
      name: "Voice 2, Maya",
    });
    const file = new File(["RIFF"], "take2.wav", { type: "audio/wav" });
    const dataTransfer = fileDataTransfer([file]);
    fireDrag(card, "dragenter", dataTransfer);
    await waitFor(() => expect(card).toHaveAttribute("data-drop-over", "true"));
    fireDrag(card, "drop", dataTransfer);
    await waitFor(() => expect(args.onDropAudio).toHaveBeenCalledWith([file]));
    await waitFor(() => expect(card).not.toHaveAttribute("data-drop-over"));
  },
};

export const WithGrip: Story = {
  args: {
    state: "ready",
    name: "Maya",
    grip: {
      onPointerDown: fn(),
      onPointerMove: fn(),
      onPointerUp: fn(),
      onPointerCancel: fn(),
      onLostPointerCapture: fn(),
    },
  },
  render: (args) => <Live {...args} />,
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
