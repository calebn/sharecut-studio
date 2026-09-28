import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { PresenceOverlayView } from "./PresenceOverlayView";
import { timelineLaneStoryDecorator } from "./timelineLaneStoryDecorator";

/** Fixed instant so a Live/Stale story doesn't depend on the clock. */
const NOW_MS = 1_800_000_000_000;

const tracks = [
  sampleTrack({ id: "mira-voice", label: "Mira" }),
  sampleTrack({ id: "ari-voice", label: "Ari" }),
];

const clips = {
  "mira-voice": [
    clipRow({
      id: "intro-clip",
      track_id: "mira-voice",
      timeline_start: 1,
      timeline_end: 3,
    }),
  ],
};

const project = minimalProject({
  tracks,
  transcript: {
    utterances: [
      {
        track_id: "mira-voice",
        speaker: "Mira",
        start: 0,
        end: 1,
        text: "Hello",
        timeline_start: 0,
        timeline_end: 1,
        words: [
          {
            text: "Hello",
            start: 0,
            end: 1,
            timeline_start: 0,
            timeline_end: 1,
            word_index: 0,
          },
        ],
      },
    ],
  },
});

const meta: Meta<typeof PresenceOverlayView> = {
  title: "Templates/PresenceOverlay",
  component: PresenceOverlayView,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    lanePreviewLabel: "Presence overlay preview",
    // Two lanes, so a remote cursor/selection has real rows to land on.
    laneTrackIds: ["mira-voice", "ari-voice"],
  },
  decorators: [timelineLaneStoryDecorator],
  args: {
    localClientId: "me",
    nowMs: NOW_MS,
    project,
    zoomPxPerSec: 40,
    height: 144,
    laneHeight: 72,
    tracks,
    clipsByTrack: clips,
  },
};

export default meta;
type Story = StoryObj<typeof PresenceOverlayView>;

export const PlayheadAndCursor: Story = {
  args: {
    clients: [
      {
        client_id: "ada",
        role: "viewer",
        last_seen_ns: NOW_MS * 1e6,
        meta: {
          display_name: "Ada",
          color_index: 2,
          transport: { playing: false, playhead_sec: 2, rate: 1 },
          cursor: { t_sec: 2, track_id: "mira-voice" },
        },
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const overlay = canvasElement.querySelector(".presence-overlay");
    await expect(overlay).toHaveAttribute("aria-hidden", "true");
    const playhead = canvasElement.querySelector(
      ".presence-playhead",
    ) as HTMLElement;
    await expect(playhead).toHaveStyle({ left: "80px" });
    await expect(
      canvasElement.querySelector(".presence-cursor-tag"),
    ).toHaveTextContent("Ada");
    await expect(
      canvasElement.querySelector(".presence-playhead-chip"),
    ).not.toBeNull();
  },
};

export const RemoteSelections: Story = {
  args: {
    clients: [
      {
        client_id: "ada",
        role: "viewer",
        last_seen_ns: NOW_MS * 1e6,
        meta: {
          display_name: "Ada",
          selection: { kind: "clip", id: "intro-clip" },
        },
      },
      {
        client_id: "bea",
        role: "viewer",
        last_seen_ns: NOW_MS * 1e6,
        meta: {
          display_name: "Bea",
          selection: {
            kind: "transcriptWord",
            track_id: "mira-voice",
            word_index: 0,
          },
        },
      },
      {
        client_id: "cy",
        role: "viewer",
        last_seen_ns: NOW_MS * 1e6,
        meta: {
          display_name: "Cy",
          selection: { kind: "pending", track_id: "mira-voice", time: 4 },
        },
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const boxes = canvasElement.querySelectorAll(".presence-selection");
    await expect(boxes).toHaveLength(3);
    await expect(boxes[0]).toHaveStyle({ left: "40px", width: "80px" });
  },
};

export const FollowedPlayheadHidden: Story = {
  args: {
    hidePlayheadForClientId: "ada",
    clients: [
      {
        client_id: "ada",
        role: "viewer",
        last_seen_ns: NOW_MS * 1e6,
        meta: {
          display_name: "Ada",
          transport: { playing: false, playhead_sec: 2, rate: 1 },
        },
      },
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".presence-playhead")).toBeNull();
  },
};

export const PhoneWidth: Story = {
  parameters: { ...recordMobileViewport.parameters, phoneWidth: true },
  globals: recordMobileViewport.globals,
  args: {
    clients: [
      {
        client_id: "ada",
        role: "viewer",
        last_seen_ns: NOW_MS * 1e6,
        meta: {
          display_name: "Ada",
          transport: { playing: false, playhead_sec: 6, rate: 1 },
        },
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const playhead = canvasElement.querySelector(
      ".presence-playhead",
    ) as HTMLElement;
    await expect(playhead).toHaveStyle({ left: "240px" });
    await expect(canvasElement.querySelector(".lane-row")).toHaveStyle({
      width: "360px",
    });
  },
};

export const PhoneStaleClient: Story = {
  parameters: { ...recordMobileViewport.parameters, phoneWidth: true },
  globals: recordMobileViewport.globals,
  args: {
    clients: [
      {
        client_id: "ada",
        role: "viewer",
        last_seen_ns: (NOW_MS - 60_000) * 1e6,
        meta: { display_name: "Ada" },
      },
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".presence-overlay")).toBeNull();
  },
};
