import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { emptyEpisode, episode, MIRA } from "../test/episodeFixture";
import { pendingEditView } from "../test/fixtures";
import { panelFrame } from "../test/panelFrame";
import { episodeBeforeEach, withEpisode } from "../test/withEpisode";
import { ImpactPanel } from "./ImpactPanel";

const meta: Meta<typeof ImpactPanel> = {
  title: "Templates/Editor · Impact panel",
  component: ImpactPanel,
  beforeEach: episodeBeforeEach,
  decorators: [panelFrame, withEpisode],
  parameters: { layout: "fullscreen", episode: {} },
};
export default meta;
type Story = StoryObj<typeof ImpactPanel>;

export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Approve all (1)" }),
    ).toBeEnabled();
    await expect(
      canvas.getByRole("button", { name: "Reject all (1)" }),
    ).toBeEnabled();
  },
};

export const AppliedEditsOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("Applied edits (1)"));
    await expect(
      await canvas.findByRole("button", { name: /Mira/ }),
    ).toBeVisible();
  },
};

export const NothingToReview: Story = {
  parameters: { episode: { project: emptyEpisode() } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Total removed")).toBeVisible();
    await expect(canvas.queryByText(/Approve all/)).toBeNull();
  },
};

export const UnmappedEdit: Story = {
  parameters: {
    episode: {
      project: episode({
        pending_edits: [
          pendingEditView({
            id: "pending-unmapped",
            track_id: MIRA,
            reason: "Remove the cough",
            mappable: false,
            timeline_start: null,
            timeline_end: null,
            timeline_spans: [],
          }),
        ],
      }),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", { name: "inspect" }),
    ).toBeVisible();
  },
};

export const CommenterCannotReview: Story = {
  parameters: { episode: { role: "commenter" } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText(
        "Only the host or an Editor can review suggestions.",
      ),
    ).toBeVisible();
  },
};

export const Phone: Story = { parameters: { dawShellPhone: true } };
