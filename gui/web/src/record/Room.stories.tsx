import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { Room } from "./Room";
import {
  recordMobileViewport,
  recordStoryDecorator,
} from "./recordStoryDecorator";
import { HOST_OFFLINE_COPY, NO_AUDIO_COPY } from "./types";

const guest = recordParticipant();
const host = recordParticipant({
  participant_id: "p_host",
  role: "host",
  display_name: "Ada",
});
const producer = recordParticipant({
  participant_id: "producer-1",
  role: "producer",
  display_name: "Cy",
  consented: null,
});
const snapshot = recordSnapshot({
  recording_ms: 42_000,
  participants: [host, guest, producer],
});
const meta: Meta<typeof Room> = {
  title: "Templates/Room",
  component: Room,
  tags: ["autodocs"],
  decorators: [recordStoryDecorator],
  args: {
    snapshot,
    me: guest,
    stream: null,
    recordingLocally: true,
    onMute: fn(),
    onLeave: fn(),
    onRetryMic: fn(),
    onCheckMic: fn(),
    onRetryKeeper: fn(),
  },
};
export default meta;
type Story = StoryObj<typeof Room>;

export const RecordingGuest: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("checkbox", { name: "Mute" }));
    await expect(args.onMute).toHaveBeenCalledWith(true);
  },
};
export const ListeningProducer: Story = {
  args: { me: producer, recordingLocally: false, hearing: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByRole("checkbox", { name: "Mute" }),
    ).toBeNull();
  },
};
export const HostDisconnected: Story = {
  args: { connected: false },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(HOST_OFFLINE_COPY),
    ).toBeVisible();
  },
};
export const MicrophoneLost: Story = {
  args: { micLost: true, micReady: false, recordingLocally: false },
};
export const MicrophonePending: Story = {
  args: { micReady: false, micPending: true, recordingLocally: false },
};
export const NoAudioCheckFailed: Story = {
  args: { noAudio: true, micCheckFailed: true },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(NO_AUDIO_COPY)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Check mic" }));
    await expect(args.onCheckMic).toHaveBeenCalledOnce();
  },
};
export const KeeperFailed: Story = {
  args: {
    keeperError: "Local storage is unavailable.",
    recordingLocally: false,
  },
};
export const PausedKeeperFailed: Story = {
  args: {
    snapshot: { ...snapshot, state: "paused" },
    keeperError: "Local storage is unavailable.",
    recordingLocally: false,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", {
        name: "Retry local recording",
      }),
    ).toBeDisabled();
  },
};
export const MonitorFailed: Story = {
  args: { monitorError: "The listening connection was interrupted." },
};
export const StoppedUploadPending: Story = {
  args: {
    snapshot: { ...snapshot, state: "stopped" },
    recordingLocally: false,
    upload: {
      acked: 2,
      total: 5,
      fileAck: false,
      landed: false,
      landFailed: false,
      reclaimFailed: false,
      uploading: true,
      pending: true,
      recoverable: false,
      error: null,
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Leave" }),
    ).toBeDisabled();
  },
};
export const StoppedLanded: Story = {
  args: {
    snapshot: { ...snapshot, state: "stopped" },
    recordingLocally: false,
    upload: {
      acked: 5,
      total: 5,
      fileAck: true,
      landed: true,
      landFailed: false,
      reclaimFailed: false,
      uploading: false,
      pending: false,
      recoverable: false,
      error: null,
    },
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Leave" }),
    );
    await expect(args.onLeave).toHaveBeenCalledOnce();
  },
};
export const GuestPhone: Story = {
  globals: recordMobileViewport.globals,
  parameters: recordMobileViewport.parameters,
};
