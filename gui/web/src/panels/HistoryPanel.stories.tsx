import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { emptyEpisode, episode } from "../test/episodeFixture";
import { panelFrame } from "../test/panelFrame";
import { episodeBeforeEach, withEpisode } from "../test/withEpisode";
import { HistoryPanel } from "./HistoryPanel";

const meta: Meta<typeof HistoryPanel> = {
  title: "Templates/Editor · History panel",
  component: HistoryPanel,
  beforeEach: episodeBeforeEach,
  decorators: [panelFrame, withEpisode],
  parameters: { layout: "fullscreen", episode: {} },
};
export default meta;
type Story = StoryObj<typeof HistoryPanel>;

export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("3 steps")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Undo" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Redo" })).toBeDisabled();
  },
};

export const Empty: Story = {
  parameters: { episode: { project: emptyEpisode() } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText("No edits yet"),
    ).toBeVisible();
  },
};

export const LoadingHistory: Story = {
  parameters: {
    episode: {
      project: episode({
        meta: {
          name: "After Hours Almanac 12",
          workspace_dir: "/episodes/after-hours",
          hydration: { history_groups: false },
        },
      }),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText("Loading history…"),
    ).toBeVisible();
  },
};

export const DiffOpen: Story = {
  parameters: {
    episode: {
      responses: {
        "/api/history/diff": {
          from_label: "before cut",
          to_label: "after Cut 20.4 to 21.2 s on Mira",
          summary: ["Removed 0.8 s from Mira", "Timeline is 0.8 s shorter"],
          diff: { timeline_duration_sec: { old: 160, new: 159.2 } },
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: /Cut 20.4 to 21.2 s on Mira/ }),
    );
    await expect(
      await canvas.findByText("Removed 0.8 s from Mira"),
    ).toBeVisible();
  },
};

export const DiffError: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: /Cut 20.4 to 21.2 s on Mira/ }),
    );
    await expect(await canvas.findByRole("alert")).toBeVisible();
  },
};

export const Phone: Story = { parameters: { dawShellPhone: true } };
