import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import type { ProsodyOverlayTrack } from "../types/prosody";
import { ProsodyOverlayView } from "./ProsodyOverlayView";
import { timelineLaneStoryDecorator } from "./timelineLaneStoryDecorator";

const fresh: ProsodyOverlayTrack = {
  track_id: "mira-voice",
  status: "fresh",
  segments: [
    {
      source_start: 0,
      source_end: 3.6,
      spans: [{ start: 0, end: 3.6 }],
      energy_thirds: [
        { db: -18, spans: [{ start: 0, end: 1.2 }] },
        { db: -22, spans: [{ start: 1.2, end: 2.4 }] },
        { db: -30, spans: [{ start: 2.4, end: 3.6 }] },
      ],
      trend: "falling",
      drop_db: 12,
      line: "Falls away at the end.",
    },
    {
      source_start: 4,
      source_end: 7.6,
      spans: [{ start: 4, end: 7.6 }],
      energy_thirds: [
        { db: -26, spans: [{ start: 4, end: 5.2 }] },
        { db: -20, spans: [{ start: 5.2, end: 6.4 }] },
        { db: -16, spans: [{ start: 6.4, end: 7.6 }] },
      ],
      trend: "rising",
      drop_db: 0,
      line: "Rises toward a question.",
    },
  ],
  boundaries: [
    { timeline_sec: 3.6, strength: 0.9, kind: "segment_end", pause_sec: 0.4 },
    { timeline_sec: 2.1, strength: 0.35, kind: "word_gap", pause_sec: 0.12 },
  ],
  prominent_words: [
    { text: "Almanac", score: 0.8, word_index: 4, timeline_sec: 1.8 },
  ],
  energy_db: { min: -34, max: -12 },
};

const meta: Meta<typeof ProsodyOverlayView> = {
  title: "Templates/ProsodyOverlay",
  component: ProsodyOverlayView,
  tags: ["autodocs"],
  decorators: [timelineLaneStoryDecorator],
  parameters: { lanePreviewLabel: "Prosody overlay preview" },
  args: { track: fresh, zoomPxPerSec: 60, x0: 0, x1: 640 },
};

export default meta;
type Story = StoryObj<typeof ProsodyOverlayView>;

export const Fresh: Story = {
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll(".prosody-seg")).toHaveLength(
      2,
    );
  },
};

export const Stale: Story = {
  args: { track: { ...fresh, status: "stale" } },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(".prosody-overlay--stale"),
    ).not.toBeNull();
  },
};

export const Missing: Story = {
  args: { track: { ...fresh, status: "missing", segments: [] } },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(".lane-prosody-status"),
    ).not.toBeNull();
  },
};

export const Unavailable: Story = {
  args: { track: { ...fresh, status: "unavailable", segments: [] } },
};
