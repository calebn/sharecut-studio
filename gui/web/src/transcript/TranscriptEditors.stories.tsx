import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { episode, MIRA } from "../test/episodeFixture";
import { withEpisode } from "../test/withEpisode";
import { InlineWordEditor } from "./InlineWordEditor";
import { TranscriptSpeakerEditor } from "./TranscriptSpeakerEditor";

const mira = episode().tracks.find((track) => track.id === MIRA);
if (!mira) throw new Error("The episode fixture has no Mira track.");

const meta: Meta = {
  title: "Templates/Editor · Transcript editors",
  decorators: [
    withEpisode,
    (Story) => (
      <main className="transcript-panel" aria-label="Transcript editor preview">
        <div className="transcript-list">
          <Story />
        </div>
      </main>
    ),
  ],
  parameters: { layout: "padded", episode: {} },
};

export default meta;
type Story = StoryObj;

export const CorrectWord: Story = {
  render: () => (
    <InlineWordEditor
      trackId={MIRA}
      wordIndex={3}
      initialText="beginning."
      onClose={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const input = await within(canvasElement).findByRole("textbox", {
      name: "Correct word “beginning.”",
    });
    await expect(input).toHaveValue("beginning.");
    await expect(input).toHaveFocus();
  },
};

export const CorrectWordEmpty: Story = {
  render: () => (
    <InlineWordEditor
      trackId={MIRA}
      wordIndex={3}
      initialText="beginning."
      onClose={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const input = await within(canvasElement).findByRole("textbox", {
      name: "Correct word “beginning.”",
    });
    await userEvent.clear(input);
    await userEvent.keyboard("{Enter}");
    await expect(
      within(canvasElement).getByText("Text cannot be empty"),
    ).toBeVisible();
  },
};

export const ChangeSpeaker: Story = {
  render: () => (
    <TranscriptSpeakerEditor
      track={mira}
      speaker="Mira"
      speakers={["Mira", "Tomas"]}
      onClose={fn()}
      onBusyChange={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const form = await canvas.findByRole("form", {
      name: `Change speaker for ${mira.label || mira.id}`,
    });
    await expect(within(form).getByRole("combobox")).toHaveValue(
      mira.speaker ?? "Mira",
    );
    await expect(
      within(form).getByRole("button", { name: "Save speaker" }),
    ).toBeEnabled();
  },
};

export const ChangeSpeakerEmpty: Story = {
  render: () => (
    <TranscriptSpeakerEditor
      track={mira}
      speaker="Mira"
      speakers={["Mira", "Tomas"]}
      onClose={fn()}
      onBusyChange={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByRole("combobox", { name: "Speaker name" });
    await userEvent.clear(input);
    await userEvent.click(canvas.getByRole("button", { name: "Save speaker" }));
    await expect(canvas.getByText("Enter a speaker name.")).toBeVisible();
  },
};
