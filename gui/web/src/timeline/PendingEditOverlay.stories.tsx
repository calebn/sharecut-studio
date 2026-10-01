import type { Meta, StoryObj } from "@storybook/react-vite";
import { act } from "react";
import {
  expect,
  fireEvent,
  fn,
  userEvent,
  waitFor,
  within,
} from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, pendingEditView } from "../test/fixtures";
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
  source_start_timeline: 4.5,
  source_end_timeline: 5.5,
  timeline_spans: [{ start: 4.5, end: 5.5 }],
});
const split = pendingEditView({
  id: "pending-split",
  type: "split",
  source_start: 7,
  source_end: 7,
  timeline_start: 7,
  timeline_end: 7,
  source_start_timeline: null,
  source_end_timeline: null,
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
    timelineWidthPx: 10000,
    selectedId: null,
    projectPath: "/tmp/story.project.json",
    clipsByTrack: {},
    canAdjust: true,
    canApply: true,
    onSelect: fn(),
    onCommitSpan: fn(),
    onReviewAction: fn(async () => ({ queued: false })),
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
    ).toHaveStyle({ left: "100px" });
  },
};

export const Selected: Story = {
  args: { selectedId: "pending-mute" },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", {
      name: "Pending mute edit, Mute 1.0s · suggested",
    });
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(button);
    await expect(args.onSelect).toHaveBeenCalledWith("pending-mute");
  },
};

export const DragEndHandle: Story = {
  args: {
    edits: [remove],
    clipsByTrack: { "mira-voice": [clipRow()] },
    selectedId: "pending-remove",
  },
  play: async ({ canvasElement, args }) => {
    const path = "/tmp/story.project.json";
    const previousFetch = globalThis.fetch;
    const previousState = useDawStore.getState();
    const snapFetch = fn();
    globalThis.fetch = async (input, init) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (requestUrl.includes("/api/waveform-snap")) {
        snapFetch(requestUrl);
        return new Response(JSON.stringify({ ticks: [] }), { status: 200 });
      }
      return previousFetch(input, init);
    };
    await act(async () => {
      useDawStore.getState().hydrate(
        path,
        minimalProject({
          pending_edits: [remove],
          clips: {
            tracks: { "mira-voice": [clipRow()] },
            clip_count: 1,
          },
        }),
      );
    });
    let handle: HTMLElement | null = null;
    let originalCapture: PropertyDescriptor | undefined;
    try {
      handle = canvasElement.querySelector(
        ".pending-handle.end",
      ) as HTMLElement;
      originalCapture = Object.getOwnPropertyDescriptor(
        handle,
        "setPointerCapture",
      );
      const capture = fn();
      Object.defineProperty(handle, "setPointerCapture", {
        configurable: true,
        value: capture,
      });
      await fireEvent.pointerDown(handle, { clientX: 120, pointerId: 1 });
      await expect(capture).toHaveBeenCalledWith(1);
      await expect(args.onSelect).toHaveBeenCalledWith("pending-remove");
      await fireEvent.pointerMove(handle, { clientX: 160, pointerId: 1 });
      await fireEvent.pointerUp(handle, { clientX: 160, pointerId: 1 });
      await waitFor(() => expect(snapFetch).toHaveBeenCalled());
      await waitFor(() =>
        expect(args.onCommitSpan).toHaveBeenCalledWith(
          path,
          useDawStore.getState().projectEpoch,
          "pending-remove",
          2,
          3,
          2,
          4,
        ),
      );
    } finally {
      if (handle) {
        if (originalCapture) {
          Object.defineProperty(handle, "setPointerCapture", originalCapture);
        } else {
          Reflect.deleteProperty(handle, "setPointerCapture");
        }
      }
      globalThis.fetch = previousFetch;
      useDawStore.setState(previousState);
    }
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
