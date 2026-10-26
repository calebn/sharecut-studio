import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { episode, tightenHits } from "../test/episodeFixture";
import { panelFrame } from "../test/panelFrame";
import { pipelineConfig } from "../test/pipelineConfigFixture";
import { episodeBeforeEach, withEpisode } from "../test/withEpisode";
import { TightenPanel } from "./TightenPanel";

const loaded = {
  episode: { responses: { "/api/pipeline/config": pipelineConfig() } },
};
const loadedWithRows = { ...loaded, panelFrameTall: true };

const meta: Meta<typeof TightenPanel> = {
  title: "Templates/Editor · Tighten panel",
  component: TightenPanel,
  beforeEach: episodeBeforeEach,
  decorators: [panelFrame, withEpisode],
  parameters: {
    layout: "fullscreen",
    episode: {
      project: episode({ pending_edits: tightenHits() }),
    },
  },
};
export default meta;
type Story = StoryObj<typeof TightenPanel>;

export const WithHits: Story = {
  parameters: loadedWithRows,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("4 of 4 hits")).toBeVisible();
    const find = await canvas.findByRole("button", { name: "Find hits" });
    await waitFor(() => expect(find).toBeEnabled());
  },
};

export const FilteredToFillers: Story = {
  parameters: loadedWithRows,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Filler" }),
    );
    await expect(await canvas.findByText("1 of 4 hits")).toBeVisible();
  },
};

export const NoMatches: Story = {
  parameters: loaded,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole("searchbox"), "zzz");
    await expect(
      await canvas.findByText("No hits match these filters."),
    ).toBeVisible();
  },
};

export const NoHits: Story = {
  parameters: {
    episode: { ...loaded.episode, project: episode({ pending_edits: [] }) },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText("No pending tighten decisions."),
    ).toBeVisible();
  },
};

export const SettingsUnavailable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/Could not load tighten settings/),
    ).toBeVisible();
    await expect(
      await canvas.findByRole("button", { name: "Retry" }),
    ).toBeVisible();
  },
};

export const Viewer: Story = {
  parameters: { episode: { ...loaded.episode, role: "viewer" } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText("4 of 4 hits"),
    ).toBeVisible();
  },
};

export const Phone: Story = {
  parameters: { ...loadedWithRows, dawShellPhone: true },
};
