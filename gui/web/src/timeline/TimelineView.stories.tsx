import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { selections } from "../test/episodeFixture";
import { withEpisode } from "../test/withEpisode";
import { TrackHeadersColumn } from "../tracks/TrackHeadersColumn";
import { TimelineView } from "./TimelineView";

const meta: Meta<typeof TimelineView> = {
  title: "Templates/Timeline",
  component: TimelineView,
  decorators: [
    withEpisode,
    (Story, context) => (
      <div
        className={`daw-shell${context.parameters.dawShellPhone ? " daw-shell--phone" : ""}`}
        style={{
          blockSize: "24rem",
          inlineSize: context.parameters.dawShellPhone ? "360px" : undefined,
        }}
      >
        <main className="daw-main daw-main--arrange">
          <Story />
        </main>
      </div>
    ),
  ],
  parameters: { ...viewportStoryParameters, episode: {} },
  args: {
    headerSlot: (
      <TrackHeadersColumn
        showAddTrack
        showSoloChip
        addDropOver={false}
        addFileCount={1}
        onAddDropOverChange={fn()}
      />
    ),
  },
};

export default meta;
type Story = StoryObj<typeof TimelineView>;

export const Arranged: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: "Open track details, Mira",
      }),
    ).toBeVisible();
  },
};

export const ClipSelected: Story = {
  parameters: { episode: { selection: selections.clip } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: "Open track details, Mira",
      }),
    ).toBeVisible();
  },
};

export const Loading: Story = {
  parameters: { episode: { state: { project: null } } },
};

export const PhoneFixedPlayhead: Story = {
  args: { fixedPlayhead: true, headerSlot: undefined },
  parameters: { dawShellPhone: true },
};
