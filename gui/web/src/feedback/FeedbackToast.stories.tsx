import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { StudioShell } from "../layout/StudioShell";
import type { FeedbackToast as FeedbackToastState } from "../state/types";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { episode } from "../test/episodeFixture";
import { withEpisode } from "../test/withEpisode";
import { FeedbackToast } from "./FeedbackToast";

const head = episode().history?.head_id ?? null;

const viewports = {
  desktop: {
    name: "Desktop 1440",
    styles: { width: "1440px", height: "900px" },
    type: "desktop",
  },
  mobile360: {
    name: "Phone 360",
    styles: { width: "360px", height: "740px" },
    type: "mobile",
  },
} as const;

const toast = (over: Partial<FeedbackToastState>): FeedbackToastState => ({
  id: 41,
  message: "Cut 3 words from Tomas",
  tone: "status",
  undo: null,
  baseHead: head,
  reverse: null,
  returnFocus: null,
  gesture: false,
  ...over,
});

function ToastOverShell() {
  return (
    <>
      <div data-daw-app-chrome>
        <StudioShell />
      </div>
      <FeedbackToast />
    </>
  );
}

const meta: Meta<typeof FeedbackToast> = {
  title: "Templates/Toast dock",
  component: FeedbackToast,
  decorators: [withEpisode],
  render: () => <ToastOverShell />,
  parameters: {
    ...viewportStoryParameters,
    viewport: { options: viewports },
    episode: { state: { feedbackToast: toast({}) } },
  },
  globals: { viewport: { value: "desktop", isRotated: false } },
};

export default meta;
type Story = StoryObj<typeof FeedbackToast>;

export const Success: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement.ownerDocument.body).findByText(
        "Cut 3 words from Tomas",
      ),
    ).toBeVisible();
  },
};

export const WithUndo: Story = {
  parameters: {
    episode: {
      state: { feedbackToast: toast({ undo: head, message: "Trimmed Mira" }) },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement.ownerDocument.body).findByText("Trimmed Mira"),
    ).toBeVisible();
  },
};

export const Failure: Story = {
  parameters: {
    episode: {
      state: {
        feedbackToast: toast({
          tone: "error",
          message: "Could not save that edit. Try again.",
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement.ownerDocument.body).findByText(
        "Could not save that edit. Try again.",
      ),
    ).toBeVisible();
  },
};

export const PhoneAboveNav: Story = {
  globals: { viewport: { value: "mobile360", isRotated: false } },
  parameters: { episode: { state: { mobileMode: "timeline" } } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement.ownerDocument.body).findByText(
        "Cut 3 words from Tomas",
      ),
    ).toBeVisible();
  },
};
