import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { sampleComment } from "../test/fixtures";
import { AuditionOverlay } from "./AuditionOverlay";
import { CommentSelectionOverlay } from "./CommentSelectionOverlay";
import { PlayheadNeedle } from "./PlayheadNeedle";

const zoomPxPerSec = 20;
const height = 120;
const pin = sampleComment({
  id: "timeline-pin",
  author: "Mira",
  body: "Check this entrance",
  timeline_start: 5,
});
const span = sampleComment({
  id: "timeline-span",
  author: "Ari",
  body: "Keep the pause",
  timeline_start: 4,
  timeline_end: 9,
});

const meta: Meta<typeof PlayheadNeedle> = {
  title: "Templates/TimelineRange",
  component: PlayheadNeedle,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen", ...recordMobileViewport.parameters },
  globals: recordMobileViewport.globals,
  args: { height, xPx: 160 },
  argTypes: {
    ref: { control: false, table: { disable: true } },
    height: { control: false, table: { disable: true } },
  },
};

export default meta;
type Story = StoryObj<typeof PlayheadNeedle>;

function Stage({
  xPx,
  audition = false,
  selected,
}: {
  xPx: number;
  audition?: boolean;
  selected?: "pin" | "span";
}) {
  return (
    <main className="timeline-area" aria-label="Timeline range preview">
      <div style={{ position: "relative", width: 360, height }}>
        {audition && (
          <AuditionOverlay
            startSec={2}
            endSec={10}
            zoomPxPerSec={zoomPxPerSec}
            height={height}
            label="Preview range"
          />
        )}
        {selected && (
          <CommentSelectionOverlay
            comment={selected === "pin" ? pin : span}
            zoomPxPerSec={zoomPxPerSec}
            height={height}
          />
        )}
        <PlayheadNeedle xPx={xPx} height={height} />
      </div>
    </main>
  );
}

export const AuditionRange: Story = {
  render: ({ xPx }) => <Stage xPx={xPx} audition />,
  play: async ({ canvasElement }) => {
    const range = canvasElement.querySelector(
      ".audition-overlay",
    ) as HTMLElement;
    await expect(range.style.left).toBe("40px");
    await expect(range.style.width).toBe("160px");
    await expect(range.textContent).toBe("Preview range");
  },
};

export const SelectedCommentSpan: Story = {
  render: ({ xPx }) => <Stage xPx={xPx} selected="span" />,
  play: async ({ canvasElement }) => {
    const selection = canvasElement.querySelector(
      ".comment-selection-overlay.span",
    ) as HTMLElement;
    await expect(selection.style.left).toBe("80px");
    await expect(selection.style.width).toBe("100px");
  },
};

export const SelectedCommentPin: Story = {
  render: ({ xPx }) => <Stage xPx={xPx} selected="pin" />,
  play: async ({ canvasElement }) => {
    const selection = canvasElement.querySelector(
      ".comment-selection-overlay.pin",
    ) as HTMLElement;
    await expect(selection.style.left).toBe("98px");
    await expect(selection.style.width).toBe("4px");
  },
};
