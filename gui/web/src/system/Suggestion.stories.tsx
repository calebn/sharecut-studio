import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { FILLER_EXCERPT, FILLER_WITH_UNSURE } from "../review/reviewFixtures";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { Suggestion } from "./Suggestion";

const meta: Meta<typeof Suggestion> = {
  title: "System/Suggestion",
  component: Suggestion,
  tags: ["autodocs"],
  args: { segments: FILLER_EXCERPT },
  decorators: [
    (Story) => (
      <p
        style={{
          padding: "var(--space-5)",
          fontSize: "var(--font-size-review)",
          lineHeight: 1.625,
        }}
      >
        <Story />
      </p>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "One drawing for a proposed change. Words the change removes are struck in the cut colour on a hatch; a pause is a hatched gap. Hatch means proposed; a solid strike belongs to an applied change. A word the transcript is unsure of has a dotted underline. The waveform form is `System/SuggestionWaveform`.\n\n**Motion.** Animations come later.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Suggestion>;

export const Text: Story = {
  play: async ({ canvasElement }) => {
    const struck = within(canvasElement).getByText("um, you know,");
    await expect(struck.closest("del")).not.toBeNull();
    await expect(
      within(canvasElement).getByText("Removed:", { exact: false }),
    ).toBeInTheDocument();
  },
};

export const Pause: Story = {
  args: { kind: "pause", length: "2.9 s", to: "0.6 s" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("2.9 s")).toBeVisible();
    await expect(canvas.getByText("0.6 s")).toBeVisible();
  },
};

export const PauseRemoved: Story = {
  args: { kind: "pause", length: "1.4 s", to: undefined },
};

export const UnsureWord: Story = {
  args: { segments: FILLER_WITH_UNSURE },
  play: async ({ canvasElement }) => {
    const word = within(canvasElement).getByText("uncle");
    await expect(word).toHaveClass("sys-sugg-unsure");
  },
};
