import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { episode, MIRA, selections } from "../../test/episodeFixture";
import { InspectorRailStory } from "../../test/InspectorRailStory";
import { withEpisode } from "../../test/withEpisode";

const meta: Meta<typeof InspectorRailStory> = {
  title: "Templates/Editor · Inspector · Word",
  component: InspectorRailStory,
  decorators: [withEpisode],
  parameters: {
    layout: "fullscreen",
    episode: { selection: selections.word },
  },
};
export default meta;
type Story = StoryObj<typeof InspectorRailStory>;

export const Word: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("heading", { name: "After" }),
    ).toBeVisible();
  },
};

export const LowConfidence: Story = {
  parameters: { episode: { selection: selections.lowConfidenceWord } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("heading", { name: "Um," }),
    ).toBeVisible();
  },
};

const after = episode().transcript?.utterances[0]?.words?.[3];
if (!after) throw new Error("The episode fixture has no fourth word.");

export const AdjustTiming: Story = {
  parameters: {
    episode: {
      state: {
        transcriptTimingRequest: {
          projectPath: episode().project_path,
          trackId: MIRA,
          sourceId: null,
          wordIndex: 3,
        },
      },
      responses: {
        "/api/transcript/word-timing-context": {
          target: { track_id: MIRA, source_id: null, word_index: 3 },
          expected_token: "timing-token-1",
          word: { text: after.text, start: after.start, end: after.end },
          neighbors: [],
          media: {
            ref: `track:${MIRA}`,
            duration_sec: 144,
            sample_rate: 48000,
            cache_key: "mira-voice-1",
          },
          window: { start: after.start - 0.6, end: after.end + 0.6 },
          warnings: [],
          transcript_gate: false,
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: /Apply timing/,
      }),
    ).toBeVisible();
  },
};
