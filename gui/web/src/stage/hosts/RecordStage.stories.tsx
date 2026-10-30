import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  portaledOverlayParameters,
  studioViewports,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { recordParticipant, recordSnapshot } from "../../test/fixtures";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import { StageFrame } from "../frame/StageFrame";
import { StageHost, type StageHostProps } from "./StageHost";

const meta: Meta<StageHostProps> = {
  title: "Stages/Record/Host",
  component: StageHost,
  beforeEach: episodeBeforeEach,
  render: ({ guestShare, loadFailure }) => (
    <StageFrame guestShare={guestShare} loadFailure={loadFailure}>
      <StageHost guestShare={guestShare} loadFailure={loadFailure} />
    </StageFrame>
  ),
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
    episode: { state: { stage: "record" } },
    docs: {
      description: {
        component:
          "The Record stage host: the embedded Room view with its Takes tray. The room hook lives in the app shell, so a live take keeps running while another stage is up; the Player is hidden here.\n\n**Motion.** The live clock ticks once a second. Nothing else moves.",
      },
    },
  },
  globals: { viewport: { value: "desktop", isRotated: false } },
};

export default meta;
type Story = StoryObj<StageHostProps>;

const phone = {
  globals: { viewport: { value: "mobile360", isRotated: false } },
} as const;

const FAILURE = { message: "The server did not answer.", onRetry: fn() };

const STATE = "GET /api/record/state";

const host = recordParticipant({
  participant_id: "p_host",
  role: "host",
  display_name: "Maya Okafor",
});
const guest = recordParticipant({
  participant_id: "p_ava",
  role: "guest",
  display_name: "Ava Lindgren",
});

const room = (over: Partial<ReturnType<typeof recordSnapshot>> = {}) =>
  recordSnapshot({
    participants: [host, guest],
    start_blockers: [],
    ...over,
  });

const withRoom = (snapshot: ReturnType<typeof recordSnapshot> | null) => ({
  episode: {
    state: { stage: "record" as const },
    record: snapshot ?? undefined,
    responses: { [STATE]: snapshot },
  },
});

export const NoRoom: Story = {
  parameters: withRoom(null),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Create record room" }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("group", { name: "Recording controls" }),
    ).toBeNull();
  },
};

export const LookingForRoom: Story = {
  parameters: {
    episode: { state: { stage: "record" }, hang: [STATE] },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText("Looking for a record room…"),
    ).toBeVisible();
  },
};

export const LookupFailed: Story = {
  parameters: { episode: { state: { stage: "record" } } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", { name: "Check again" }),
    ).toBeVisible();
  },
};

export const Lobby: Story = {
  parameters: withRoom(
    room({ state: "lobby", take_index: -1, recording_ms: 0 }),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Record" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("group", { name: "Player" })).toBeNull();
  },
};

/** Edit's Re-record parked a Replace target; the room takes it on opening. */
export const HostPickupFromSelection: Story = {
  parameters: {
    episode: {
      state: {
        stage: "record" as const,
        pendingRecordTarget: {
          kind: "replace" as const,
          from_sec: 724,
          to_sec: 1000,
          track_ids: ["t1"],
          script: "…the reason we didn't ship it…",
        },
      },
      record: room({ state: "lobby", take_index: -1, recording_ms: 0 }),
      responses: {
        [STATE]: room({ state: "lobby", take_index: -1, recording_ms: 0 }),
        "POST /api/record/command": room({
          state: "lobby",
          take_index: -1,
          recording_ms: 0,
          target: {
            kind: "replace",
            from_sec: 724,
            to_sec: 1000,
            track_ids: ["t1"],
          },
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText("Replaces 12:04-16:40"),
    ).toBeVisible();
    await expect(
      await within(canvasElement).findByText("…the reason we didn't ship it…"),
    ).toBeVisible();
  },
};

export const Live: Story = {
  parameters: withRoom(room({ state: "recording", recording_ms: 70_000 })),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Stop take" }),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Comment" })).toBeVisible();
  },
};

export const Paused: Story = {
  parameters: withRoom(room({ state: "paused", recording_ms: 70_000 })),
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: "Resume recording",
      }),
    ).toBeVisible();
  },
};

export const SavingTakes: Story = {
  parameters: withRoom(
    room({
      state: "stopped",
      take_index: 0,
      takes: [
        {
          take_index: 0,
          session_start_wall_ms: 1000,
          session_start_iso: "2026-10-01T10:00:00Z",
          stopped_wall_ms: 91_000,
          pauses: [],
          consented_participant_ids: ["p_host", "p_ava"],
        },
      ],
    }),
  ),
  play: async ({ canvasElement }) => {
    const peek = canvasElement.querySelector<HTMLElement>(
      ".sys-room-view-peek",
    );
    if (peek) {
      await userEvent.click(peek);
    }
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await screen.findByRole("tab", { name: "Takes" }));
    await expect(
      await screen.findByRole("button", { name: /^Take 1/ }),
    ).toBeVisible();
  },
};

export const MoreSheet: Story = {
  parameters: withRoom(
    room({ state: "lobby", take_index: -1, recording_ms: 0 }),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "More" }));
    await expect(
      await within(document.body).findByRole("dialog", { name: "More" }),
    ).toBeVisible();
  },
};

export const Loading: Story = {
  parameters: { episode: { state: { stage: "record", project: null } } },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("main", { name: "Record" });
    await expect(
      canvasElement.querySelector(
        "[data-stage-host='record'][aria-busy='true']",
      ),
    ).not.toBeNull();
  },
};

export const LoadError: Story = {
  args: { loadFailure: FAILURE },
  parameters: { episode: { state: { stage: "record", project: null } } },
  play: async ({ args, canvasElement }) => {
    const host = canvasElement.querySelector<HTMLElement>(
      "[data-stage-host='record']",
    );
    await userEvent.click(
      await within(host as HTMLElement).findByRole("button", { name: "Retry" }),
    );
    await expect(args.loadFailure?.onRetry).toHaveBeenCalledOnce();
  },
};

export const PhoneLive: Story = {
  ...phone,
  parameters: withRoom(room({ state: "recording", recording_ms: 70_000 })),
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", { name: "Stop take" }),
    ).toBeVisible();
  },
};

export const GuestViewer: Story = {
  args: { guestShare: true },
  parameters: { episode: { role: "viewer", state: { stage: "record" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("This link can't open that"),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("group", { name: "Recording controls" }),
    ).toBeNull();
  },
};
