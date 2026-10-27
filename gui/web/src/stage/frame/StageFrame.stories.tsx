import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { useDawStore } from "../../state/dawStore";
import {
  portaledOverlayParameters,
  studioViewports,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { episode } from "../../test/episodeFixture";
import { recordSnapshot } from "../../test/fixtures";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import { StageFrame } from "./StageFrame";

const meta: Meta<typeof StageFrame> = {
  title: "Stages/Edit/Frame",
  component: StageFrame,
  beforeEach: episodeBeforeEach,
  args: {
    children: (
      <div style={{ padding: "var(--space-5)" }}>The stage host goes here.</div>
    ),
  },
  decorators: [
    withEpisode,
    (Story) => (
      <div data-daw-app-chrome>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    viewport: { options: studioViewports },
    episode: {},
    docs: {
      description: {
        component:
          "The app-wired frame: header, banners, the stage body slot, the Player and, on a phone, the tab bar. The stage hosts slot in as children; this frame mounts nothing else of the editor.",
      },
    },
  },
  globals: { viewport: { value: "desktop", isRotated: false } },
};

export default meta;
type Story = StoryObj<typeof StageFrame>;

const WIDE_ONLY_REASON =
  "The play needs the desktop frame and a 360 px viewport selects the phone one.";
const WIDE_ONLY = {
  tags: ["wide-only"],
  parameters: { wideOnlyReason: WIDE_ONLY_REASON },
};

const phone = {
  globals: { viewport: { value: "mobile360", isRotated: false } },
} as const;

const stageTabs = (canvasElement: HTMLElement) =>
  within(canvasElement).getAllByRole("tablist", { name: "Stages" })[0];

export const Desktop: Story = {
  ...WIDE_ONLY,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: /After Hours/ }),
    ).toBeVisible();
    await expect(
      within(stageTabs(canvasElement)).getAllByRole("tab"),
    ).toHaveLength(5);
    await expect(canvas.getByRole("group", { name: "Player" })).toBeVisible();
    await expect(canvas.getByRole("main", { name: "Edit" })).toBeVisible();
  },
};

export const Tablet: Story = {
  globals: { viewport: { value: "tablet", isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("main", { name: "Edit" }),
    ).toBeVisible();
  },
};

export const SwitchStage: Story = {
  ...WIDE_ONLY,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await within(stageTabs(canvasElement)).findByRole("tab", {
        name: /Review/,
      }),
    );
    await waitFor(() => expect(useDawStore.getState().stage).toBe("review"));
    await expect(canvas.getByRole("main", { name: "Review" })).toBeVisible();
  },
};

export const PhoneTabs: Story = {
  ...phone,
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("main", { name: "Edit" }),
    ).toBeVisible();
    // jsdom has no media queries, so only a real phone viewport shows the tab bar.
    if (canvasElement.querySelector(".stage-frame--phone")) {
      await expect(
        canvasElement.querySelectorAll(".sys-stage-bar--tabs"),
      ).toHaveLength(1);
    }
  },
};

export const PhoneGuestViewer: Story = {
  ...phone,
  args: { guestShare: true },
  parameters: { episode: { role: "viewer", state: { stage: "review" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("main", { name: "Review" }),
    ).toBeVisible();
    await expect(
      canvasElement.querySelector(".sys-stage-bar--tabs"),
    ).toBeNull();
  },
};

export const Loading: Story = {
  parameters: { episode: { state: { project: null } } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("main", { name: "Edit" }),
    ).toBeVisible();
    // The Player waits too: Play says why it cannot start yet.
    await expect(
      within(canvasElement).getByRole("button", { name: "Play" }),
    ).toHaveAccessibleDescription("Loading project…");
    await expect(
      canvasElement.querySelector("[aria-busy='true']"),
    ).not.toBeNull();
  },
};

export const Empty: Story = {
  parameters: {
    episode: {
      project: episode({
        tracks: [],
        clips: { tracks: {}, clip_count: 0 },
        timeline_duration_sec: 0,
        transcript: { utterances: [] },
      }),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("main", { name: "Edit" }),
    ).toBeVisible();
  },
};

export const LoadError: Story = {
  args: {
    loadFailure: { message: "The server did not answer.", onRetry: fn() },
  },
  parameters: { episode: { state: { project: null } } },
  play: async ({ args, canvasElement }) => {
    const banner = (
      await within(canvasElement).findByText(
        /Could not load transcript and history/,
      )
    ).closest<HTMLElement>("[role='alert']");
    await userEvent.click(
      within(banner as HTMLElement).getByRole("button", { name: "Retry" }),
    );
    await expect(args.loadFailure?.onRetry).toHaveBeenCalledOnce();
  },
};

export const RecordNoPlayer: Story = {
  parameters: { episode: { state: { stage: "record" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("main", { name: "Record" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("group", { name: "Player" })).toBeNull();
  },
};

export const RecordingLive: Story = {
  tags: ["wide-only"],
  parameters: {
    wideOnlyReason: WIDE_ONLY_REASON,
    episode: {
      state: { stage: "edit" },
      record: recordSnapshot({ state: "recording", recording_ms: 70_000 }),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(stageTabs(canvasElement)).findByRole("tab", {
        name: /Record.*Live/,
      }),
    ).toBeVisible();
  },
};

export const GuestEditor: Story = {
  args: { guestShare: true },
  parameters: { episode: { role: "editor" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        "Shared edit view · You can add tracks and audio",
      ),
    ).toBeVisible();
    await expect(
      within(stageTabs(canvasElement)).getAllByRole("tab"),
    ).toHaveLength(2);
    await expect(canvas.queryByRole("button", { name: "A" })).toBeNull();
  },
};

export const GuestViewer: Story = {
  args: { guestShare: true },
  parameters: { episode: { role: "viewer", state: { stage: "review" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Shared read-only view"),
    ).toBeVisible();
    await expect(canvas.queryByRole("tablist", { name: "Stages" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Invite" })).toBeNull();
  },
};
