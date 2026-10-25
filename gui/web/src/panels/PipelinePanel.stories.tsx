import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { episode, pipelineJob } from "../test/episodeFixture";
import { panelFrame } from "../test/panelFrame";
import { pipelineConfig } from "../test/pipelineConfigFixture";
import { withEpisode } from "../test/withEpisode";
import { PipelinePanel } from "./PipelinePanel";

const loaded = {
  episode: {
    responses: { "/api/pipeline/config": pipelineConfig() },
  },
};

const meta: Meta<typeof PipelinePanel> = {
  title: "Templates/Editor · Pipeline panel",
  component: PipelinePanel,
  decorators: [panelFrame, withEpisode],
  parameters: { layout: "fullscreen", episode: { project: episode() } },
};
export default meta;
type Story = StoryObj<typeof PipelinePanel>;

export const Idle: Story = {
  parameters: loaded,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("checkbox", { name: "Enable Balance tracks" }),
    ).toBeChecked();
    await expect(
      await canvas.findByRole("heading", { name: "Balance tracks" }),
    ).toBeVisible();
  },
};

export const Running: Story = {
  parameters: {
    episode: {
      ...loaded.episode,
      state: { pipelineJob, activityJob: pipelineJob },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("checkbox", {
        name: "Enable Balance tracks",
      }),
    ).toBeDisabled();
  },
};

export const MissingComponent: Story = {
  parameters: {
    episode: {
      responses: {
        "/api/pipeline/config": pipelineConfig({
          components: {
            ffmpeg: {
              state: "missing",
              hint: "Install ffmpeg to render audio",
            },
            whisper: { state: "installed" },
          },
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText(
        "Missing ffmpeg: Install ffmpeg to render audio",
      ),
    ).toBeVisible();
  },
};

export const SettingsUnavailable: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText(
        "Analyze to load the pipeline steps.",
      ),
    ).toBeVisible();
  },
};

export const Phone: Story = {
  parameters: { ...loaded, dawShellPhone: true },
};

export const PhoneStepParameters: Story = {
  parameters: {
    episode: { ...loaded.episode, state: { shellBreakpoint: "phone" } },
    dawShellPhone: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Master mix" }),
    );
    await expect(
      await within(document.body).findByRole("dialog", {
        name: "Step parameters",
      }),
    ).toBeVisible();
  },
};
