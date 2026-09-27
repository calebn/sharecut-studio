import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import type { AutomationPoint } from "../types/project";
import { EnvelopeOverlayView } from "./EnvelopeOverlayView";
import { timelineLaneStoryDecorator } from "./timelineLaneStoryDecorator";

const points: AutomationPoint[] = [
  { id: "a", time: 1, value: 1 },
  { id: "b", time: 5, value: 0.5 },
  { id: "c", time: 9, value: 1.2 },
];

const meta: Meta<typeof EnvelopeOverlayView> = {
  title: "Templates/EnvelopeOverlay",
  component: EnvelopeOverlayView,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    lanePreviewLabel: "Envelope overlay preview",
  },
  decorators: [timelineLaneStoryDecorator],
  args: {
    points,
    zoomPxPerSec: 40,
    width: 640,
    height: 72,
    visibleChunks: [0, 0],
    editable: true,
    selectedIndex: null,
    onSelectTrack: fn(),
    onSelectPoint: fn(),
    onCommitPoints: fn(() => Promise.resolve({})),
    onCommitError: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof EnvelopeOverlayView>;

export const Editable: Story = {
  play: async ({ canvasElement, args }) => {
    const circles = canvasElement.querySelectorAll("circle");
    await expect(circles).toHaveLength(3);
    (circles[1] as SVGCircleElement).dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    await expect(args.onSelectPoint).toHaveBeenCalledWith(1);
    await expect(args.onCommitPoints).not.toHaveBeenCalled();
  },
};

export const Selected: Story = {
  args: { selectedIndex: 1 },
  play: async ({ canvasElement }) => {
    const circles = canvasElement.querySelectorAll("circle");
    await expect(circles[1]).toHaveAttribute("r", "7");
  },
};

export const ReadOnly: Story = {
  args: { editable: false },
  play: async ({ canvasElement }) => {
    const circles = canvasElement.querySelectorAll("circle");
    await expect(circles[0]).toHaveAttribute("r", "2.5");
  },
};

export const PhoneWidth: Story = {
  parameters: { ...recordMobileViewport.parameters, phoneWidth: true },
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".lane-row")).toHaveStyle({
      width: "360px",
    });
  },
};

export const PhoneEmpty: Story = {
  parameters: { ...recordMobileViewport.parameters, phoneWidth: true },
  globals: recordMobileViewport.globals,
  args: { points: [] },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".envelope-overlay")).toBeNull();
  },
};
