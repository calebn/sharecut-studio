import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { useArgState } from "../test/storyDialog";
import { DeviceSheet, type DeviceSheetProps } from "./DeviceSheet";
import type { DeviceMic } from "./deviceSheetModel";
import { RoomView } from "./RoomView";
import type { RoomPerson } from "./roomViewModel";

// Fixtures for every story below. Stubbed state only: nothing here is wired.
const ANNEKE = { name: "Anneke de Vries", colorIndex: 1 };
const MAYA = { name: "Maya Okafor", colorIndex: 0 };

const IN_ROOM: RoomPerson[] = [
  { role: "host", person: MAYA, presence: "live", connection: "good" },
  {
    id: "you",
    role: "guest",
    person: ANNEKE,
    you: true,
    presence: "live",
    connection: "good",
    level: 0.35,
  },
];

const MIC_READY = {
  status: "ready",
  input: "MacBook Pro Microphone",
  level: 0.35,
  devices: [
    { id: "builtin", label: "MacBook Pro Microphone" },
    { id: "usb", label: "Shure MV7" },
  ],
  inputId: "builtin",
} satisfies DeviceMic;

const TONE_IDLE = {
  state: "idle",
  label: "Record 1 minute of room tone",
} as const;

/** The room the sheet opens over, with the viewer's own tile in it. */
function Devices(args: DeviceSheetProps) {
  const [headphones, setHeadphones] = useArgState(args.headphones ?? false);
  return (
    <div style={{ blockSize: "44rem", inlineSize: "100%" }}>
      <RoomView
        seat="guest"
        title="Episode 14: the one about the mic"
        people={IN_ROOM}
        phase={{ kind: "waiting", host: "Maya" }}
        viewerWidth={args.viewerWidth === "phone" ? "phone" : "desktop"}
        notes={[]}
        selfName="Anneke"
        onSendNote={fn()}
      />
      <DeviceSheet
        {...args}
        headphones={headphones}
        onHeadphonesChange={setHeadphones}
      />
    </div>
  );
}

const meta: Meta<DeviceSheetProps> = {
  title: "Stages/Record/DeviceSheet",
  component: DeviceSheet,
  tags: ["autodocs"],
  render: (args) => <Devices {...args} />,
  args: {
    viewerWidth: "desktop",
    mic: MIC_READY,
    tone: TONE_IDLE,
    onMicAction: fn(),
    onInputChange: fn(),
    onRecordRoomTone: fn(),
    onClose: fn(),
  },
  parameters: {
    ...isolatedStoryParameters,
    docs: {
      ...isolatedStoryParameters.docs,
      description: {
        component:
          "Opened by pressing your own tile, or from the room's More menu. One Sheet over the live room: the microphone row (input menu when there are two or more, a level meter with a clip tick, and the same states as the Join sheet's mic row), the headphone toggle where the seat has one, and Record room tone (1 minute, for someone who joined after the countdown). Every control applies as it changes, so there is no Apply. The input menu locks while a take is running, and room tone waits for the gap between takes. Desktop is a centred card; the phone is a bottom Sheet. Presentational: the caller owns the microphone, the meter and the room tone.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<DeviceSheetProps>;

/** True once the element and every ancestor are fully opaque. */
const opaque = (element: Element | null): boolean => {
  for (let node = element; node; node = node.parentElement) {
    if (Number(getComputedStyle(node).opacity || 1) < 1) return false;
  }
  return true;
};

/** The open sheet, once its fade-in has settled and its initial focus has landed. */
const sheet = async () => {
  const dialog = await within(document.body).findByRole("dialog", {
    name: "Devices",
  });
  const panel = dialog.querySelector(".sys-join-sheet") ?? dialog;
  await waitFor(() => expect(opaque(panel)).toBe(true));
  await waitFor(() =>
    expect(dialog.contains(document.activeElement)).toBe(true),
  );
  return within(dialog);
};

const state = () =>
  document.querySelector("[data-state].sys-join")?.getAttribute("data-state");

export const Ready: Story = {
  args: { headphones: true },
  play: async ({ args, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(state()).toBe("ready");
    await userEvent.selectOptions(dialog.getByLabelText("Input"), "usb");
    await expect(args.onInputChange).toHaveBeenCalledWith("usb");
    await userEvent.click(
      dialog.getByRole("button", { name: "Record 1 minute of room tone" }),
    );
    await expect(args.onRecordRoomTone).toHaveBeenCalledTimes(1);
    await expect(dialog.queryByRole("button", { name: /apply/i })).toBeNull();
  },
};

export const Denied: Story = {
  args: { mic: { status: "denied" } },
  play: async ({ args, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(state()).toBe("denied");
    await expect(dialog.getByText("Microphone blocked")).toBeVisible();
    await userEvent.click(
      dialog.getByRole("button", { name: "How to allow the microphone" }),
    );
    await expect(args.onMicAction).toHaveBeenCalledWith("how-to");
  },
};

export const InputLost: Story = {
  args: { mic: { status: "lost", detail: "Microphone disconnected." } },
  play: async ({ args, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(state()).toBe("input-lost");
    await expect(dialog.getByText("Microphone disconnected.")).toBeVisible();
    await userEvent.click(
      dialog.getByRole("button", { name: "Retry microphone" }),
    );
    await expect(args.onMicAction).toHaveBeenCalledWith("retry");
  },
};

export const NoInput: Story = {
  args: { mic: { status: "none" } },
  play: async ({ args, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(state()).toBe("no-input");
    await expect(dialog.getByText("No microphone found")).toBeVisible();
    await userEvent.click(
      dialog.getByRole("button", { name: "Retry microphone" }),
    );
    await expect(args.onMicAction).toHaveBeenCalledWith("retry");
  },
};

export const RoomToneTooLoud: Story = {
  args: {
    tone: {
      state: "too-loud",
      label: "Record 1 minute of room tone",
      message: "Too loud: is something playing?",
    },
  },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(state()).toBe("room-tone-too-loud");
    await expect(
      dialog.getByText("Too loud: is something playing?"),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Record 1 minute of room tone" }),
    ).toBeEnabled();
  },
};

export const RoomToneTooShort: Story = {
  args: {
    tone: {
      state: "too-short",
      label: "Record 1 minute of room tone",
      message: "Too short, record at least 10 seconds",
    },
  },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(state()).toBe("ready");
    await expect(
      dialog.getByText("Too short, record at least 10 seconds"),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Record 1 minute of room tone" }),
    ).toBeEnabled();
  },
};

export const RoomToneCapturing: Story = {
  args: {
    tone: {
      state: "capturing",
      label: "Record 1 minute of room tone",
      message: "Stay quiet · 0:42",
      progress: 0.3,
    },
    onEndRoomToneEarly: fn(),
    onCancelRoomTone: fn(),
  },
  play: async ({ args, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(dialog.getByText("Stay quiet · 0:42")).toBeVisible();
    await expect(
      dialog.getByRole("progressbar", { name: "Room tone" }),
    ).toHaveAttribute("aria-valuenow", "30");
    await expect(
      dialog.queryByRole("button", { name: "Record 1 minute of room tone" }),
    ).toBeNull();
    await userEvent.click(dialog.getByRole("button", { name: "End early" }));
    await expect(args.onEndRoomToneEarly).toHaveBeenCalledTimes(1);
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await expect(args.onCancelRoomTone).toHaveBeenCalledTimes(1);
  },
};

export const Phone: Story = {
  args: { viewerWidth: "phone", headphones: true },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await sheet();
    await expect(dialog.getByLabelText("Input")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Record 1 minute of room tone" }),
    ).toBeVisible();
  },
};
