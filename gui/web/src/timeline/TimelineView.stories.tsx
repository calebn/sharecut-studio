import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { TrackColumn } from "../stage/edit/TrackColumn";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { EPISODE_DURATION_SEC, selections } from "../test/episodeFixture";
import { sessionRoster } from "../test/fixtures";
import {
  RECORDED_SESSIONS_RESPONSE,
  recordedSessionsProject,
} from "../test/sessionBandsFixture";
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
    await expect(
      canvasElement.querySelectorAll(".clip-block").length,
    ).toBeGreaterThan(0);
    await expect(
      within(canvasElement).queryByRole("button", {
        name: /^Select .* clip/,
        pressed: true,
      }),
    ).toBeNull();
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
    // The selected clip is drawn pressed.
    await expect(
      within(canvasElement).getByRole("button", {
        name: /^Select Mira clip/,
        pressed: true,
      }),
    ).toBeVisible();
  },
};

export const Loading: Story = {
  tags: ["storybook-only"],
  parameters: { episode: { state: { project: null } } },
};

export const PhoneFixedPlayhead: Story = {
  args: { fixedPlayhead: true, headerSlot: undefined },
  parameters: { framePhone: true },
};

const recordedEpisode = { project: recordedSessionsProject() };

export const WithRecordedSessions: Story = {
  parameters: {
    episode: {
      ...recordedEpisode,
      responses: { "/api/record/sessions": RECORDED_SESSIONS_RESPONSE },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Mira" }),
    ).toBeVisible();
    // The pills need a measured ruler window, which jsdom has not; SessionBandLayer.test.tsx presses them.
  },
};

export const SessionsLoading: Story = {
  parameters: {
    episode: { ...recordedEpisode, hang: ["/api/record/sessions"] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Mira" }),
    ).toBeVisible();
    await expect(canvas.queryByText("S1")).toBeNull();
  },
};

export const SessionsError: Story = {
  parameters: { episode: recordedEpisode },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Mira" }),
    ).toBeVisible();
    await expect(canvas.queryByText("S1")).toBeNull();
  },
};

export const GuestNoSessions: Story = {
  parameters: { episode: { ...recordedEpisode, role: "viewer" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Mira" }),
    ).toBeVisible();
    await expect(canvas.queryByText("S1")).toBeNull();
  },
};

const seenNow = () => Date.now() * 1e6;
const remote = (id: string, playhead_sec: number) => ({
  client_id: id,
  role: "viewer",
  playhead_sec,
  last_seen_ns: seenNow(),
  meta: { display_name: id.toUpperCase() },
});

/** Remote flags at several times, over the ruler's first and last labels: the label text stays on top (#2919). */
export const RemoteFlagsOverRulerLabels: Story = {
  parameters: {
    episode: {
      state: {
        localClientId: "me",
        sessionRosterVersion: 5,
        sessionClients: sessionRoster([
          { ...remote("me", 1), meta: {} },
          ...[0, 1, 60, 61, 120, EPISODE_DURATION_SEC - 0.5].map((at, i) =>
            remote(`r${i}`, at),
          ),
        ]),
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", { name: "Mira" }),
    ).toBeVisible();
  },
};
