import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { useDaw } from "../state/useDaw";
import { selections } from "../test/episodeFixture";
import { episodeBeforeEach, withEpisode } from "../test/withEpisode";
import { InspectorPeek } from "./InspectorPeek";
import { peekTarget } from "./peekTarget";

function SelectionPeek() {
  const { project, selection } = useDaw((s) => ({
    project: s.project,
    selection: s.selection,
  }));
  const peek = project ? peekTarget(project, selection, null) : null;
  return peek ? <InspectorPeek peek={peek} /> : null;
}

const meta: Meta<typeof SelectionPeek> = {
  title: "Templates/Editor · Inspector · Peek",
  component: SelectionPeek,
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  parameters: {
    layout: "fullscreen",
    episode: { selection: selections.pendingEdit },
  },
};
export default meta;
type Story = StoryObj<typeof SelectionPeek>;

export const PendingEdit: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("group", {
        name: "Nudge pending remove start",
      }),
    ).toBeVisible();
  },
};

export const Chapter: Story = {
  parameters: { episode: { selection: selections.chapter } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText("The harbor depot"),
    ).toBeVisible();
  },
};

export const Viewer: Story = {
  parameters: { episode: { role: "viewer" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Mira", { exact: false }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("group", { name: "Nudge pending remove start" }),
    ).toBeNull();
  },
};
