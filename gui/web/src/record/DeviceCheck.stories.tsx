import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { DeviceCheck } from "./DeviceCheck";
import {
  MIC_ALLOW_LABEL,
  MIC_DENIED_COPY,
  MIC_ERROR_COPY,
  MIC_LOST_COPY,
  MIC_RETRY_LABEL,
  MIC_SAVED_DEVICE_MISSING_COPY,
  MIC_UNAVAILABLE_COPY,
} from "./micPermission";
import { recordStoryDecorator } from "./recordStoryDecorator";

const input = (deviceId: string, label: string) =>
  ({ deviceId, label }) as MediaDeviceInfo;

const meta: Meta<typeof DeviceCheck> = {
  title: "Templates/DeviceCheck",
  component: DeviceCheck,
  tags: ["autodocs"],
  decorators: [recordStoryDecorator],
  args: {
    headphonesOk: true,
    deviceId: "",
    onDeviceId: fn(),
    stream: null,
    devices: [],
    error: null,
    settingsWarning: null,
    onAllow: fn(),
    onRetry: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof DeviceCheck>;

export const AwaitingPermission: Story = {
  args: {
    permission: "idle",
    grantHintId: "device-idle-grant",
    headphonesHintId: "device-idle-headphones",
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: MIC_ALLOW_LABEL }),
    );
    await expect(args.onAllow).toHaveBeenCalledOnce();
  },
};

export const Prompting: Story = {
  args: {
    permission: "prompting",
    grantHintId: "device-prompting-grant",
    headphonesHintId: "device-prompting-headphones",
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: MIC_ALLOW_LABEL }),
    ).toBeDisabled();
  },
};

export const GrantedNoStream: Story = {
  args: {
    permission: "granted",
    deviceId: "usb",
    devices: [input("usb", "USB microphone"), input("built-in", "Built-in")],
    stream: null,
    grantHintId: "device-granted-grant",
    headphonesHintId: "device-granted-headphones",
  },
  parameters: {
    docs: {
      description: {
        story:
          "Permission is granted and inputs are listed; no live mic is attached in Storybook.",
      },
    },
  },
  play: async ({ canvasElement, args }) => {
    const inputSelect = within(canvasElement).getByRole("combobox", {
      name: "Input",
    });
    await expect(inputSelect).toHaveValue("usb");
    await userEvent.selectOptions(inputSelect, "built-in");
    await expect(args.onDeviceId).toHaveBeenCalledWith("built-in");
  },
};

export const Denied: Story = {
  args: {
    permission: "denied",
    grantHintId: "device-denied-grant",
    headphonesHintId: "device-denied-headphones",
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(MIC_DENIED_COPY)).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: MIC_RETRY_LABEL }),
    );
    await expect(args.onRetry).toHaveBeenCalledOnce();
  },
};

export const MissingSavedInput: Story = {
  args: {
    permission: "granted",
    notice: MIC_SAVED_DEVICE_MISSING_COPY,
    grantHintId: "device-missing-grant",
    headphonesHintId: "device-missing-headphones",
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(MIC_SAVED_DEVICE_MISSING_COPY),
    ).toBeVisible();
  },
};

export const InputLost: Story = {
  args: {
    permission: "lost",
    grantHintId: "device-lost-grant",
    headphonesHintId: "device-lost-headphones",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(MIC_LOST_COPY)).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: MIC_RETRY_LABEL }),
    ).toBeEnabled();
  },
};

export const NoInputAvailable: Story = {
  args: {
    permission: "unavailable",
    grantHintId: "device-unavailable-grant",
    headphonesHintId: "device-unavailable-headphones",
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(MIC_UNAVAILABLE_COPY),
    ).toBeVisible();
  },
};

export const InputError: Story = {
  args: {
    permission: "error",
    grantHintId: "device-error-grant",
    headphonesHintId: "device-error-headphones",
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(MIC_ERROR_COPY)).toBeVisible();
  },
};
