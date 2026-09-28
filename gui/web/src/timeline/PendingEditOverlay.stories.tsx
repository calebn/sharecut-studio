import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { pendingEditView } from "../test/fixtures";
import { PendingEditOverlayView } from "./PendingEditOverlayView";
import { timelineLaneStoryDecorator } from "./timelineLaneStoryDecorator";

const remove = pendingEditView({
  id: "pending-remove",
  type: "remove",
  source_start: 2,
  source_end: 3,
  timeline_start: 2,
  timeline_end: 3,
  timeline_spans: [{ start: 2, end: 3 }],
});
const mute = pendingEditView({
  id: "pending-mute",
  type: "mute",
  source_start: 4.5,
  source_end: 5.5,
  timeline_start: 4.5,
  timeline_end: 5.5,
  timeline_spans: [{ start: 4.5, end: 5.5 }],
});
const split = pendingEditView({
  id: "pending-split",
  type: "split",
  source_start: 7,
  source_end: 7,
  timeline_start: 7,
  timeline_end: 7,
  timeline_spans: [{ start: 7, end: 7 }],
});

const meta: Meta<typeof PendingEditOverlayView> = {
  title: "Templates/PendingEditOverlay",
  component: PendingEditOverlayView,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    lanePreviewLabel: "Pending edit preview",
  },
  decorators: [timelineLaneStoryDecorator],
  args: {
    edits: [remove, mute, split],
    trackId: "mira-voice",
    zoomPxPerSec: 40,
    selectedId: null,
    onSelect: fn(),
    onCommitSpan: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof PendingEditOverlayView>;

export const Kinds: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelectorAll(".pending-overlay.remove"),
    ).toHaveLength(1);
    await expect(
      canvasElement.querySelectorAll(".pending-overlay.mute"),
    ).toHaveLength(1);
    await expect(
      canvasElement.querySelectorAll(".pending-overlay.split"),
    ).toHaveLength(1);
    await expect(
      canvasElement.querySelector(".pending-overlay.remove"),
    ).toHaveStyle({ left: "80px" });
  },
};

export const Selected: Story = {
  args: { selectedId: "pending-mute" },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", {
      name: "Pending mute edit",
    });
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(button);
    await expect(args.onSelect).toHaveBeenCalledWith("pending-mute");
  },
};

export const DragEndHandle: Story = {
  args: { edits: [remove] },
  play: async ({ canvasElement, args }) => {
    const handle = canvasElement.querySelector(
      ".pending-handle.end",
    ) as HTMLElement;
    void fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    void fireEvent.pointerMove(handle, { clientX: 140, pointerId: 1 });
    void fireEvent.pointerUp(handle, { clientX: 140, pointerId: 1 });
    await expect(args.onCommitSpan).toHaveBeenCalledWith(
      "pending-remove",
      2,
      4,
    );
  },
};

export const PhoneWidth: Story = {
  parameters: { ...recordMobileViewport.parameters, phoneWidth: true },
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".lane-row")).toHaveStyle({
      width: "360px",
    });
    await expect(
      canvasElement.querySelectorAll(".pending-overlay"),
    ).toHaveLength(3);
  },
};

export const FilteredTrack: Story = {
  args: { trackId: "ari-voice" },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelectorAll(".pending-overlay"),
    ).toHaveLength(0);
  },
};
