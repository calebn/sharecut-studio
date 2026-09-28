import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import {
  minimalProject,
  pipelineJobSnapshot,
  sampleTrack,
  sessionClient,
} from "../test/fixtures";
import { staleRenderBreakdown } from "../utils/staleRender";
import { PresenceStatusView } from "./PresenceStatusView";
import { StatusBarView } from "./StatusBarView";
import { statusBarSummary } from "./statusBarSummary";

const summaryOf = (project: ReturnType<typeof minimalProject>) =>
  statusBarSummary(project, staleRenderBreakdown(project));

const EPISODE = minimalProject({
  tracks: [sampleTrack({ duration_sec: 1689.4 })],
  timeline_duration_sec: 221.3,
  edit_impact: {
    pending_review_count: 3,
    total_removed_sec: 0,
    by_track_sec: {},
  },
  render_status: {
    needs_rerender: false,
    reconciliation: { stale: false },
    premix: { exists: true },
    invalidations: [],
  },
});

const STALE_EPISODE = minimalProject({
  ...EPISODE,
  render_status: {
    needs_rerender: false,
    reconciliation: { stale: true },
    premix: { exists: false },
    invalidations: [],
  },
});

const ROSTER = [
  sessionClient({
    client_id: "story-host",
    role: "host",
    meta: { display_name: "You", color_index: 0 },
  }),
  sessionClient({
    client_id: "story-guest",
    role: "guest",
    meta: { display_name: "Guest", color_index: 1 },
  }),
  sessionClient({
    client_id: "story-agent",
    role: "agent",
    meta: { display_name: "Agent", color_index: 2 },
  }),
];

const meta: Meta<typeof StatusBarView> = {
  title: "Templates/StatusBar",
  component: StatusBarView,
  tags: ["autodocs"],
  decorators: [
    (Story, context) => {
      const phone = Boolean(context.parameters.statusBarPhone);
      return (
        <div
          style={{
            containerType: "inline-size",
            containerName: "app",
            width: phone ? "360px" : undefined,
          }}
        >
          <main
            aria-label="Stage"
            style={{ blockSize: "var(--transport-height)" }}
          />
          <Story />
        </div>
      );
    },
  ],
  args: {
    narrow: false,
    statusAnnouncement: "",
    onOpenTab: () => {},
  },
};
export default meta;

type Story = StoryObj<typeof meta>;

export const Desktop: Story = {
  args: {
    summary: summaryOf(EPISODE),
    presence: (
      <PresenceStatusView
        narrow={false}
        clients={ROSTER}
        localClientId="story-host"
      />
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Cut 24:28 of 28:09")).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Mix up to date" }),
    ).toBeInTheDocument();
  },
};

export const StaleRender: Story = {
  args: {
    summary: summaryOf(STALE_EPISODE),
    reconcileHighlight: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Mix out of date" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByText("Transcript: needs sync"),
    ).toBeInTheDocument();
  },
};

export const GuestActivity: Story = {
  args: {
    summary: summaryOf(EPISODE),
    job: pipelineJobSnapshot({
      kind: "agent",
      label: "align_tracks",
      status: "running",
      message: "Scoring bleed windows",
      current: null,
      total: null,
    }),
    runningCount: 2,
    onJobClick: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole("button", { name: /Activity: running/ }),
    ).not.toBeInTheDocument();
    await expect(canvas.getByText(/2 activities/)).toBeInTheDocument();
  },
};

export const Loading: Story = {
  args: {
    summary: null,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Loading episode…")).toBeInTheDocument();
  },
};

export const Announcement: Story = {
  args: {
    summary: summaryOf(EPISODE),
    statusAnnouncement: "Stopped following",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const status = canvas.getByRole("status");
    await expect(status).toHaveTextContent("Stopped following");
  },
};

export const PhoneWidth: Story = {
  parameters: { statusBarPhone: true },
  args: {
    summary: summaryOf(EPISODE),
    narrow: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Open comments" }).className,
    ).toContain("status-bar-secondary");
  },
};
