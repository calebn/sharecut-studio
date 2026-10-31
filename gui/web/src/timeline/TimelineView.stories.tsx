import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { TrackColumn } from "../stage/edit/TrackColumn";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { selections } from "../test/episodeFixture";
import { episodeBeforeEach, withEpisode } from "../test/withEpisode";
import { TimelineView } from "./TimelineView";

const meta: Meta<typeof TimelineView> = {
  title: "Templates/Timeline",
  component: TimelineView,
  beforeEach: episodeBeforeEach,
  decorators: [
    withEpisode,
    (Story, context) => (
      <div
        className={`stage-frame stage-frame--${context.parameters.framePhone ? "phone" : "desktop"}`}
        style={{
          blockSize: "24rem",
          gridTemplateRows: "minmax(0, 1fr)",
          inlineSize: context.parameters.framePhone ? "360px" : undefined,
        }}
      >
        <main className="stage-frame-body">
          <div className="edit-workspace">
            <div className="edit-timeline-col">
              <div className="edit-timeline-main">
                <Story />
              </div>
            </div>
          </div>
        </main>
      </div>
    ),
  ],
  parameters: { ...viewportStoryParameters, episode: {} },
  args: {
    headerSlot: <TrackColumn showSoloChip />,
  },
};

export default meta;
type Story = StoryObj<typeof TimelineView>;

export const Arranged: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: "Mira",
      }),
    ).toBeVisible();
  },
};

export const ClipSelected: Story = {
  parameters: { episode: { selection: selections.clip } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: "Mira",
      }),
    ).toBeVisible();
  },
};

export const Loading: Story = {
  parameters: { episode: { state: { project: null } } },
};

export const PhoneFixedPlayhead: Story = {
  args: { fixedPlayhead: true, headerSlot: undefined },
  parameters: { framePhone: true },
};
