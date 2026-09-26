import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { Lobby } from "./Lobby";
import { MIC_ALLOW_LABEL } from "./micPermission";
import {
  recordMobileViewport,
  recordStoryDecorator,
} from "./recordStoryDecorator";
import { LOCAL_KEEPER_PENDING_COPY, ROOM_TONE_GATE_COPY } from "./types";

const meta: Meta<typeof Lobby> = {
  title: "Templates/Lobby",
  component: Lobby,
  tags: ["autodocs"],
  decorators: [recordStoryDecorator],
  args: {
    producer: false,
    name: "Bo",
    onName: fn(),
    headphonesOk: false,
    onHeadphones: fn(),
    deviceId: "",
    onDeviceId: fn(),
    onJoinProducer: fn(),
    onAccept: fn(),
    onDecline: fn(),
    showMic: true,
    stream: null,
    devices: [],
    micError: null,
    settingsWarning: null,
    permission: "idle",
    onAllowMic: fn(),
    onRetryMic: fn(),
    storageHeadroomNotice: null,
  },
};

export default meta;
type Story = StoryObj<typeof Lobby>;

export const GuestNeedsSetup: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Accept" })).toBeDisabled();
    await userEvent.click(
      canvas.getByRole("button", { name: MIC_ALLOW_LABEL }),
    );
    await expect(args.onAllowMic).toHaveBeenCalledOnce();
  },
};

export const GuestReady: Story = {
  args: {
    permission: "granted",
    headphonesOk: true,
    roomToneStatus: "skipped",
  },
  play: async ({ canvasElement, args }) => {
    const accept = within(canvasElement).getByRole("button", {
      name: "Accept",
    });
    await expect(accept).toBeEnabled();
    await userEvent.click(accept);
    await expect(args.onAccept).toHaveBeenCalledOnce();
  },
};

export const RoomToneBlocked: Story = {
  args: {
    permission: "granted",
    headphonesOk: true,
    roomToneReady: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(ROOM_TONE_GATE_COPY)).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Accept" })).toBeDisabled();
  },
};

export const LocalBackupPending: Story = {
  args: {
    permission: "granted",
    headphonesOk: true,
    roomToneStatus: "skipped",
    localStorageReady: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(LOCAL_KEEPER_PENDING_COPY)).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Accept" })).toBeDisabled();
  },
};

export const Producer: Story = {
  args: { producer: true, showMic: false, name: "Cy" },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: "Accept" })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Join" }));
    await expect(args.onJoinProducer).toHaveBeenCalledOnce();
  },
};

export const Connecting: Story = {
  args: { showMic: false },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Connecting to the room…"),
    ).toBeVisible();
  },
};

export const GuestMobile: Story = {
  globals: recordMobileViewport.globals,
  parameters: recordMobileViewport.parameters,
  args: {
    permission: "granted",
    headphonesOk: true,
    roomToneStatus: "skipped",
  },
};
