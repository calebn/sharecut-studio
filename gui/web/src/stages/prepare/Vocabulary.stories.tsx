import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { NEAR_LIMIT_TERMS, SOME_TERMS, SPEAKER_NAMES } from "./prepareFixture";
import { Vocabulary, type VocabularyProps } from "./Vocabulary";

const meta: Meta<typeof Vocabulary> = {
  title: "Stages/Prepare/Vocabulary",
  component: Vocabulary,
  tags: ["autodocs"],
  args: {
    speakers: SPEAKER_NAMES,
    terms: [],
    onTermsChange: fn(),
    onRetranscribe: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{
          padding: "var(--space-5)",
          maxInlineSize: "20rem",
          background: "var(--color-bg-canvas)",
        }}
      >
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
          'Help the transcriber: one field, "Names and terms", with a chip for each name or term. The people from the Source cards come first with a person icon and cannot be removed here; Enter or a comma adds a term, Backspace on an empty field removes the last one. It saves on every change, so there is no Save button. The character count shows only within 40 of the limit, as "25 left", and at the limit the field says "That is the limit. Remove a term to add more." The limit is 372 characters of names and terms, not the 400 the old screen showed, because the transcriber\'s own lead-in takes the rest. After transcription has run, a new term shows "Applies next time words are transcribed." and a Re-transcribe button. Chips are plain wrapping rows, so the field is as wide as its column and grows downward.\n\n**Motion.** Adding or removing a chip is instant; the focus ring uses `--motion-hover`. Not implemented in this slice.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Vocabulary>;

/** Holds the terms the way the project will: every change is also passed on. */
function Live(props: VocabularyProps) {
  const [terms, setTerms] = useState(props.terms);
  return (
    <Vocabulary
      {...props}
      terms={terms}
      onTermsChange={(next) => {
        setTerms(next);
        props.onTermsChange(next);
      }}
    />
  );
}

const live: Story["render"] = (args) => <Live {...args} />;

export const Empty: Story = {
  render: live,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { level: 2, name: "Help the transcriber" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("listitem", { name: "Maya Okafor, speaker" }),
    ).toBeVisible();
    const field = canvas.getByRole("textbox", { name: "Names and terms" });
    await userEvent.type(field, "Quetzalcoatlus{Enter}");
    await expect(args.onTermsChange).toHaveBeenLastCalledWith([
      "Quetzalcoatlus",
    ]);
    await expect(canvas.queryByText(/ left$/)).toBeNull();
  },
};

export const WithChips: Story = {
  args: { terms: SOME_TERMS },
  render: live,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Remove Tessellate Systems" }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: /Remove Maya/ }),
    ).toBeNull();
  },
};

export const NearLimit: Story = {
  args: { terms: NEAR_LIMIT_TERMS },
  render: live,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("25 left")).toBeVisible();
    const field = canvas.getByRole("textbox", { name: "Names and terms" });
    await userEvent.type(field, "Another very long term indeed{Enter}");
    await expect(
      canvas.getAllByText("That is the limit. Remove a term to add more.")[0],
    ).toBeVisible();
  },
};

export const AfterTranscribe: Story = {
  args: { terms: SOME_TERMS, needsRetranscribe: true },
  render: live,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Applies next time words are transcribed."),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Re-transcribe" }),
    );
    await expect(args.onRetranscribe).toHaveBeenCalled();
  },
};

export const Phone: Story = {
  args: { terms: SOME_TERMS, needsRetranscribe: true },
  render: live,
  globals: { viewport: { value: "mobile360", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Re-transcribe" }),
    ).toBeVisible();
  },
};
