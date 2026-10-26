import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { episode } from "../test/episodeFixture";
import { episodeBeforeEach, withEpisode } from "../test/withEpisode";
import { TranscriptVocabularyEditor } from "./TranscriptVocabularyEditor";

const vocabulary = {
  show_title: "After Hours Almanac",
  prompt_limit: 224,
  prompt_primer: "After Hours Almanac, a show for people who work nights.",
  terms: ["Almanac", "depot", "overnight"],
  guest_names: ["Tomas Reyes"],
  revision: "rev-3",
  needs_retranscription: false,
  edited_tracks: [],
};

const meta: Meta<typeof TranscriptVocabularyEditor> = {
  title: "Templates/Pipeline · Transcript vocabulary",
  component: TranscriptVocabularyEditor,
  beforeEach: episodeBeforeEach,
  decorators: [
    withEpisode,
    (Story) => (
      <div className="daw-shell" style={{ inlineSize: "min(28rem, 100%)" }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "padded", episode: {} },
  args: {
    projectPath: episode().project_path,
    busy: false,
    onRetranscribe: fn(),
    refreshKey: "idle",
  },
};

export default meta;
type Story = StoryObj<typeof TranscriptVocabularyEditor>;

export const Saved: Story = {
  parameters: {
    episode: { responses: { "/api/transcript/vocabulary": vocabulary } },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText("Almanac"),
    ).toBeVisible();
  },
};

export const NeedsRetranscription: Story = {
  parameters: {
    episode: {
      responses: {
        "/api/transcript/vocabulary": {
          ...vocabulary,
          terms: [...vocabulary.terms, "foghorn"],
          needs_retranscription: true,
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: /Re-transcribe/,
      }),
    ).toBeVisible();
  },
};

export const LoadFailed: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: /Retry|Reload/,
      }),
    ).toBeVisible();
  },
};
