import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { renderInvalidation } from "../test/fixtures";
import { StaleInvalidationOverlay } from "./StaleInvalidationOverlay";
import { timelineLaneStoryDecorator } from "./timelineLaneStoryDecorator";

const cut = renderInvalidation();
const short = renderInvalidation({
  id: "brief-fade",
  timeline_start: 7,
  timeline_end: 7.01,
  reason: "envelope",
});
const overlapping = renderInvalidation({
  id: "fx-overlap",
  timeline_start: 3,
  timeline_end: 6,
  reason: "fx",
});
const clipped = renderInvalidation({
  id: "right-edge",
  timeline_start: 17.5,
  timeline_end: 20,
  reason: "clip",
});
const filtered = [
  cut,
  renderInvalidation({ id: "other-lane", track_ids: ["ari-voice"] }),
  renderInvalidation({
    id: "whole-lane",
    timeline_start: null,
    timeline_end: null,
  }),
];

const meta: Meta<typeof StaleInvalidationOverlay> = {
  title: "Templates/StaleInvalidationOverlay",
  component: StaleInvalidationOverlay,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [timelineLaneStoryDecorator],
  args: {
    invalidations: [cut],
    trackId: "mira-voice",
    zoomPxPerSec: 20,
    width: 640,
  },
};

export default meta;
type Story = StoryObj<typeof StaleInvalidationOverlay>;

export const RegionalCut: Story = {
  play: async ({ canvasElement }) => {
    const band = canvasElement.querySelector(".stale-inv-band");
    await expect(band).toHaveStyle({ left: "40px", width: "60px" });
    await expect(band).toHaveAttribute("title", "cut · 2.0–5.0s");
  },
};

export const BriefChange: Story = {
  args: { invalidations: [short] },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".stale-inv-band")).toHaveStyle({
      left: "140px",
      width: "3px",
    });
  },
};

export const OverlappingCauses: Story = {
  args: { invalidations: [cut, overlapping] },
  play: async ({ canvasElement }) => {
    const bands = canvasElement.querySelectorAll(".stale-inv-band");
    await expect(bands).toHaveLength(2);
    await expect(bands[1]).toHaveAttribute("title", "fx · 3.0–6.0s");
  },
};

export const PhoneRightEdge: Story = {
  parameters: { ...recordMobileViewport.parameters, phoneWidth: true },
  globals: recordMobileViewport.globals,
  args: { invalidations: [clipped], width: 360 },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".lane-row")).toHaveStyle({
      width: "360px",
    });
    await expect(canvasElement.querySelector(".stale-inv-band")).toHaveStyle({
      left: "350px",
      width: "10px",
    });
  },
};

export const PhoneFiltered: Story = {
  parameters: { ...recordMobileViewport.parameters, phoneWidth: true },
  globals: recordMobileViewport.globals,
  args: { invalidations: filtered, width: 360 },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelectorAll(".stale-inv-band"),
    ).toHaveLength(1);
  },
};

export const PhoneEmpty: Story = {
  parameters: { ...recordMobileViewport.parameters, phoneWidth: true },
  globals: recordMobileViewport.globals,
  args: { invalidations: filtered, trackId: "no-stale-regions", width: 360 },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".stale-inv-overlay")).toBeNull();
  },
};
