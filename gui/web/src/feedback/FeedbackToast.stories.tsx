import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { StageFrame } from "../stage/frame/StageFrame";
import type { FeedbackToast as FeedbackToastState } from "../state/types";
import {
  portaledOverlayParameters,
  studioViewports,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { episode } from "../test/episodeFixture";
import { episodeBeforeEach, withEpisode } from "../test/withEpisode";
import { FeedbackToast } from "./FeedbackToast";

const head = episode().history?.head_id ?? null;

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

function ToastOverFrame() {
  return (
    <>
      <div data-daw-app-chrome>
        <StageFrame>
          <div style={{ padding: "var(--space-5)" }}>Stage host</div>
        </StageFrame>
      </div>
      <FeedbackToast />
    </>
  );
}

const meta: Meta<typeof FeedbackToast> = {
  title: "Templates/Toast dock",
  component: FeedbackToast,
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  render: () => <ToastOverFrame />,
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    viewport: { options: studioViewports },
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

export const PhoneAboveTabBar: Story = {
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
