import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import type { TranscriptFormat } from "../../api";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { TranscriptSection } from "./TranscriptSection";
import {
  SAMPLE_FILES,
  transcriptOptions,
  transcriptRows,
} from "./transcriptFixtures";

type Args = React.ComponentProps<typeof TranscriptSection>;

function Controlled(args: Args) {
  const [choices, setChoices] = useState<readonly TranscriptFormat[]>(
    args.options.choices,
  );
  return (
    <TranscriptSection
      {...args}
      options={{ ...args.options, choices, onChoices: setChoices }}
    />
  );
}

const meta: Meta<typeof TranscriptSection> = {
  title: "Stages/Deliver/Transcript",
  component: TranscriptSection,
  tags: ["autodocs"],
  render: (args) => <Controlled {...args} />,
  args: {
    options: transcriptOptions({
      onExport: fn(),
      onCopy: fn(),
      onPrepare: fn(),
      onRetry: fn(),
    }),
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
          "The edited transcript as text, Markdown, SRT or VTT, written next to the audio. A preview shows the first turns as the files will hold them.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof TranscriptSection>;

export const Ready: Story = {
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole("button", { name: "Text" }));
    await expect(view.getByRole("button", { name: "Text" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(view.getByRole("button", { name: "Export 3 files" }));
    await expect(args.options.onExport).toHaveBeenCalledOnce();
  },
};

export const Compact: Story = { args: { compact: true } };

export const Loading: Story = {
  args: {
    options: transcriptOptions({ preview: { kind: "loading" }, onRetry: fn() }),
  },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(
      await view.findByText("Still loading…", {}, { timeout: 5000 }),
    ).toBeVisible();
    await userEvent.click(view.getByRole("button", { name: "Retry" }));
    await expect(args.options.onRetry).toHaveBeenCalledOnce();
  },
};

export const NotTranscribed: Story = {
  args: { options: transcriptOptions({ preview: { kind: "none" } }) },
};

export const EverythingCut: Story = {
  args: { options: transcriptOptions({ preview: { kind: "allCut" } }) },
};

export const LoadFailed: Story = {
  args: {
    options: transcriptOptions({
      preview: { kind: "failed", cause: "The backend is not reachable." },
      onRetry: fn(),
    }),
  },
};

export const Writing: Story = {
  args: { options: transcriptOptions({ run: { phase: "writing" } }) },
};

export const Done: Story = {
  args: {
    options: transcriptOptions({
      run: { phase: "done", files: SAMPLE_FILES },
    }),
    files: transcriptRows(),
  },
};

export const ExportFailed: Story = {
  args: {
    options: transcriptOptions({
      run: { phase: "failed", cause: "The export folder is not writable." },
    }),
  },
};

export const EditedSinceExport: Story = {
  args: { options: transcriptOptions(), files: transcriptRows(false) },
};

export const CopyBlocked: Story = {
  args: { options: transcriptOptions({ copyState: "blocked" }) },
};
