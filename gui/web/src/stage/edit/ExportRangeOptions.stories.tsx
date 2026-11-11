import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { makeRangeTarget } from "../../edit/rangeSelection";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { episode, MIRA, TOMAS } from "../../test/episodeFixture";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import type { Selection } from "../../types/project";
import { ExportRangeOptions } from "./ExportRangeOptions";

const project = episode();
const range = makeRangeTarget(project, [{ start: 1, end: 5 }], [MIRA, TOMAS]);
const rangeSelection: Selection = {
  kind: "range",
  target: range!,
};
const tracksSelection: Selection = {
  kind: "track",
  trackId: MIRA,
  trackIds: [MIRA, TOMAS],
};

const meta: Meta = {
  title: "Stages/Edit/ExportRangeOptions",
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  render: () => (
    <div
      style={{
        display: "grid",
        gap: "var(--space-3)",
        padding: "var(--space-4)",
        maxWidth: "20rem",
      }}
    >
      <ExportRangeOptions />
    </div>
  ),
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The content of the Export options popover beside the Export verb: which tracks the export mixes (Full mix, Selected tracks, Soloed) and Also MP3. Each change is saved as it is made and applies to the next Export. A choice with nothing to export is disabled with its reason. On the phone the same content opens from the More row.",
      },
    },
  },
};

export default meta;
type Story = StoryObj;

export const Range: Story = {
  parameters: {
    episode: { project, role: "host", selection: rangeSelection },
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      await view.findByRole("button", { name: "Full mix" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      view.getByRole("button", { name: "Also MP3" }),
    ).toHaveAttribute("aria-pressed", "false");
  },
};

export const NoSoloedTrack: Story = {
  parameters: {
    episode: { project, role: "host", selection: rangeSelection },
  },
  play: async ({ canvasElement }) => {
    const soloed = await within(canvasElement).findByRole("button", {
      name: "Soloed",
    });
    await expect(soloed).toBeDisabled();
    await expect(soloed).toHaveAttribute(
      "title",
      "Solo one or more tracks first.",
    );
  },
};

export const SoloedTrack: Story = {
  parameters: {
    episode: {
      project,
      role: "host",
      selection: rangeSelection,
      state: { soloTracks: { [TOMAS]: true } },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", { name: "Soloed" }),
    ).toBeEnabled();
  },
};

export const SelectedTracks: Story = {
  parameters: {
    episode: { project, role: "host", selection: tracksSelection },
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      await view.findByRole("button", { name: "Selected tracks" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(view.getByRole("button", { name: "Full mix" })).toBeDisabled();
  },
};
