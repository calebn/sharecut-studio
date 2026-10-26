import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { DialogLauncher } from "../test/DialogLauncher";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { openDialogByLauncher } from "../test/storyDialog";
import { TAKE_CONTROL } from "./hostControls";
import { copyForMicStatus } from "./micPermission";
import { RecordPanelView } from "./RecordPanelView";
import { recordStoryDecorator } from "./recordStoryDecorator";
import type { RecordUploadProgress } from "./upload/useRecordUpload";

const openDialog = (canvasElement: HTMLElement) =>
  openDialogByLauncher(canvasElement, {
    launcherName: "Open record room",
    dialogName: "Record room",
  });

const host = recordParticipant({
  participant_id: "p_host",
  role: "host",
  display_name: "Ada",
});
const guest = recordParticipant({
  participant_id: "guest-1",
  display_name: "Bo",
});

const lobby = recordSnapshot({
  state: "lobby",
  take_index: -1,
  participants: [host, guest],
});
const recording = recordSnapshot({
  recording_ms: 84_000,
  participants: [host, guest],
});
const stopped = recordSnapshot({
  state: "stopped",
  participants: [host, guest],
});

const upload = (
  over: Partial<RecordUploadProgress> = {},
): RecordUploadProgress => ({
  acked: 0,
  total: 0,
  fileAck: false,
  landed: false,
  landFailed: false,
  reclaimFailed: false,
  uploading: false,
  pending: false,
  recoverable: false,
  segments: [],
  error: null,
  ...over,
});

function RecordPanelPreview({
  initiallyOpen,
  ...args
}: ComponentProps<typeof RecordPanelView> & { initiallyOpen: boolean }) {
  return (
    <DialogLauncher label="Open record room" initiallyOpen={initiallyOpen}>
      {(open, close) => (
        <RecordPanelView
          {...args}
          open={open}
          onClose={() => {
            close();
            args.onClose();
          }}
        />
      )}
    </DialogLauncher>
  );
}

const meta: Meta<typeof RecordPanelView> = {
  title: "Templates/Record · Host panel",
  component: RecordPanelView,
  tags: ["autodocs"],
  decorators: [recordStoryDecorator],
  parameters: { ...isolatedStoryParameters, layout: "padded" },
  args: {
    open: false,
    onClose: fn(),
    closeDisabled: false,
    snapshot: lobby,
    roomLookup: "found",
    host,
    onCommand: fn(),
    onCheckAgain: fn(),
    transportBusy: false,
    takeControlRef: { current: null },
    control: TAKE_CONTROL.lobby,
    land: null,
    startBlocked: false,
    blockers: [],
    blockersId: "record-blockers",
    startFixes: { retryStorage: fn() },
    doneNotice: null,
    capture: null,
    offline: false,
    takeClipping: null,
    jumpFor: () => null,
    stream: null,
    storageReady: true,
    roomTone: {
      status: "idle",
      delivery: "device",
      error: null,
      captureReady: true,
      record: fn(),
      skip: fn(),
      retry: fn(),
    },
    reconnectCopy: null,
    recordingLocally: false,
    keeperError: null,
    onRetryKeeper: fn(),
    noAudioNeedsAttention: false,
    micLossNeedsAttention: false,
    micLost: false,
    onRetryMic: fn(),
    onCheckMic: fn(),
    micCheckFailed: false,
    hearing: false,
    micHintId: "record-mic-hint",
    micCopy: null,
    micPending: false,
    micFailed: false,
    micStatus: "granted",
    micError: null,
    sinkError: null,
    onRetryStorage: fn(),
    monitorError: null,
    hydrateError: null,
    transportError: null,
    upload: upload(),
    keeperActions: {
      busy: false,
      error: null,
      notice: null,
      download: fn(),
      recover: fn(),
    },
    hostSegments: [],
    onResumeUpload: fn(),
    hasRemovedParticipant: false,
    liveComments: {
      note: "",
      setNote: fn(),
      postMarker: fn(),
      submitNote: fn(),
    },
    onCopyLinks: fn(),
    onMuteChange: fn(),
  },
  argTypes: { open: { control: false } },
  render: (args, context) => (
    <RecordPanelPreview
      {...args}
      initiallyOpen={context.viewMode === "story"}
    />
  ),
};

export default meta;
type Story = StoryObj<typeof RecordPanelView>;

export const Checking: Story = {
  args: { snapshot: null, roomLookup: "checking", control: null },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByText("Looking for a record room…"),
    ).toBeVisible();
  },
};

export const NoRoom: Story = {
  args: { snapshot: null, roomLookup: "none", control: null },
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create record room" }),
    );
    await expect(args.onCommand).toHaveBeenCalledWith("record.createRoom");
  },
};

export const LookupFailed: Story = {
  args: {
    snapshot: null,
    roomLookup: "failed",
    control: null,
    hydrateError: "The local server did not answer.",
  },
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Check again" }),
    );
    await expect(args.onCheckAgain).toHaveBeenCalledOnce();
  },
};

export const LobbyBlocked: Story = {
  args: {
    startBlocked: true,
    blockers: [{ key: "no_recorder", text: "Joining the room." }],
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByRole("button", { name: "Start" }),
    ).toBeDisabled();
    await expect(within(dialog).getByText("Joining the room.")).toBeVisible();
  },
};

export const LobbyReady: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Start" }),
    );
    await expect(args.onCommand).toHaveBeenCalledWith("record.start");
  },
};

export const Recording: Story = {
  args: {
    snapshot: recording,
    control: TAKE_CONTROL.recording,
    recordingLocally: true,
  },
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: "Mute my mic" }),
    );
    await expect(args.onMuteChange).toHaveBeenCalledWith(true);
    await expect(
      within(dialog).getByRole("button", { name: "Pause" }),
    ).toBeVisible();
  },
};

export const Paused: Story = {
  args: {
    snapshot: recordSnapshot({
      state: "paused",
      participants: [host, guest],
    }),
    control: TAKE_CONTROL.paused,
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByRole("button", { name: "Resume" }),
    ).toBeVisible();
  },
};

export const Reconnecting: Story = {
  args: {
    snapshot: recording,
    control: TAKE_CONTROL.recording,
    offline: true,
    recordingLocally: true,
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(within(dialog).getByText(/Reconnecting/)).toBeVisible();
  },
};

export const MicrophoneLost: Story = {
  args: {
    snapshot: recording,
    control: TAKE_CONTROL.recording,
    micLost: true,
    micLossNeedsAttention: true,
    closeDisabled: true,
  },
};

export const NoAudio: Story = {
  args: {
    snapshot: recording,
    control: TAKE_CONTROL.recording,
    capture: "failed",
    noAudioNeedsAttention: true,
  },
};

export const MicrophoneDenied: Story = {
  args: {
    micStatus: "denied",
    micCopy: copyForMicStatus("denied"),
    micFailed: true,
  },
};

export const KeeperStopped: Story = {
  args: {
    snapshot: recording,
    control: TAKE_CONTROL.recording,
    keeperError: "The disk is full.",
  },
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Retry full-quality recording",
      }),
    );
    await expect(args.onRetryKeeper).toHaveBeenCalledOnce();
  },
};

export const StorageError: Story = {
  args: {
    snapshot: recording,
    control: TAKE_CONTROL.recording,
    sinkError: "Local recording storage is unavailable.",
  },
};

export const StoppedUploading: Story = {
  args: {
    snapshot: stopped,
    control: TAKE_CONTROL.stopped,
    land: { enabled: false, label: "Land", reason: "Saving is not finished." },
    upload: upload({ acked: 2, total: 5, uploading: true, pending: true }),
  },
};

export const StoppedReadyToLand: Story = {
  args: {
    snapshot: stopped,
    control: TAKE_CONTROL.stopped,
    land: { enabled: true, label: "Land" },
    upload: upload({ acked: 5, total: 5, fileAck: true }),
  },
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await userEvent.click(within(dialog).getByRole("button", { name: "Land" }));
    await expect(args.onCommand).toHaveBeenCalledWith("record.land");
  },
};

export const CommandFailed: Story = {
  args: {
    transportError: "The room did not accept that command.",
    doneNotice: "Guest link copied.",
  },
};

export const RemovedParticipant: Story = {
  args: { hasRemovedParticipant: true },
};
