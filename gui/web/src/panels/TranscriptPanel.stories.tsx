import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useDawStore } from "../state/dawStore";
import { episode, selections } from "../test/episodeFixture";
import { panelFrame } from "../test/panelFrame";
import { withEpisode } from "../test/withEpisode";
import {
  TRANSCRIPT_MODE_HINT,
  TRANSCRIPT_SELECT_TOUCH_HINT,
} from "../transcript/transcriptModeCopy";
import type { ProjectView } from "../types/project";
import { TranscriptPanel } from "./TranscriptPanel";

function withIgnoredPhrase(project: ProjectView): ProjectView {
  const utterances = project.transcript?.utterances ?? [];
  return {
    ...project,
    transcript: {
      utterances: utterances.map((u, turn) =>
        turn === 1
          ? {
              ...u,
              ignored_word_indices: [4, 5],
              words: u.words?.map((w) =>
                w.word_index === 4 || w.word_index === 5
                  ? { ...w, ignored: true }
                  : w,
              ),
            }
          : u,
      ),
    },
  };
}

const meta: Meta<typeof TranscriptPanel> = {
  title: "Templates/Editor · Transcript panel",
  component: TranscriptPanel,
  decorators: [panelFrame, withEpisode],
  parameters: { layout: "fullscreen", episode: {} },
};
export default meta;
type Story = StoryObj<typeof TranscriptPanel>;

const modeButton = (canvas: ReturnType<typeof within>, name: RegExp) =>
  canvas.findByRole("button", { name });

export const Navigate: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/40 utterances/)).toBeVisible();
    await expect(
      await canvas.findByText(TRANSCRIPT_MODE_HINT.navigate),
    ).toBeVisible();
  },
};

export const Annotate: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await modeButton(canvas, /^Annotate:/));
    await expect(
      await canvas.findByRole("group", { name: "Low-confidence review" }),
    ).toBeVisible();
  },
};

export const LowConfidenceStepping: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await modeButton(canvas, /^Annotate:/));
    await userEvent.click(await modeButton(canvas, /^Next low-confidence/i));
    await expect(await canvas.findByText(/1\/3 low-confidence/)).toBeVisible();
  },
};

export const Correct: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await modeButton(canvas, /^Correct:/));
    await expect(
      await canvas.findByText(TRANSCRIPT_MODE_HINT.correct),
    ).toBeVisible();
  },
};

export const SelectRange: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await modeButton(canvas, /^Select:/));
    useDawStore.getState().setSelection(selections.range);
    await expect(
      await canvas.findByRole("button", { name: /Ignore/ }),
    ).toBeEnabled();
  },
};

export const IgnoredWords: Story = {
  parameters: { episode: { project: withIgnoredPhrase(episode()) } },
  play: async ({ canvasElement }) => {
    const restore = await within(canvasElement).findByRole("button", {
      name: /^Restore ignored:/,
    });
    restore.focus();
    await waitFor(() => expect(restore).toBeVisible());
  },
};

export const FindAndReplace: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Find/ }));
    await expect(
      await canvas.findByRole("textbox", { name: /Find/ }),
    ).toBeVisible();
  },
};

export const TextLayoutCorrecting: Story = {
  parameters: {
    episode: {
      selection: selections.word,
      state: { layoutMode: "text", shellBreakpoint: "desktop" },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("heading", { name: "After" }),
    ).toBeVisible();
  },
};

export const LoadingWords: Story = {
  parameters: {
    episode: {
      project: episode({
        meta: {
          name: "After Hours Almanac 12",
          workspace_dir: "/episodes/after-hours",
          hydration: { transcript_words: false },
        },
      }),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText(/40 utterances/),
    ).toBeVisible();
  },
};

export const NoTranscript: Story = {
  parameters: { episode: { project: episode({ transcript: null }) } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText("No combined transcript."),
    ).toBeVisible();
  },
};

export const Viewer: Story = {
  parameters: { episode: { role: "viewer" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/40 utterances/)).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: /^Correct:/ }),
    ).toBeNull();
  },
};

export const Phone: Story = {
  parameters: {
    dawShellPhone: true,
    episode: { state: { shellBreakpoint: "phone", pointerKind: "coarse" } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await modeButton(canvas, /^Select:/));
    await expect(
      await canvas.findByText(TRANSCRIPT_SELECT_TOUCH_HINT),
    ).toBeVisible();
  },
};
