import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { RoomAlert } from "./RoomAlert";
import type { RoomAlertInput, RoomAlertKind } from "./roomAlertModel";

const meta: Meta<typeof RoomAlert> = {
  title: "Stages/Record/RoomAlert",
  component: RoomAlert,
  tags: ["autodocs"],
  args: { alerts: [] },
  decorators: [
    (Story) => (
      <div
        style={{
          padding: "var(--space-5)",
          maxInlineSize: "22.5rem",
        }}
      >
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          'The record alert slot: one 44 px Status row under the header with a 20 px glyph, one sentence and one action (saving failed may add Save a copy; room tone adds Skip). The most urgent alert shows (mic lost, no audio, storage failed, saving failed, a notice, recovery, host offline, monitor failed, room tone for a late joiner, clipping, muted, connecting, generic). A "+N" chip opens the rest as Status rows. With no alert the live region stays mounted and empty, so the slot takes no height.\n\n**Motion.** None. Alerts appear and change without animation.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof RoomAlert>;

const ONE = (kind: RoomAlertKind, rest: Partial<RoomAlertInput> = {}) => ({
  alerts: [{ kind, onAction: fn(), ...rest }],
});

const firstAction = (alerts: RoomAlertInput[] | undefined) =>
  alerts?.[0]?.onAction;

const expectOneAction = async (
  canvasElement: HTMLElement,
  label: string,
  onAction: (() => void) | undefined,
) => {
  const canvas = within(canvasElement);
  await expect(canvas.getAllByRole("button")).toHaveLength(1);
  await userEvent.click(canvas.getByRole("button", { name: label }));
  await expect(onAction).toHaveBeenCalledOnce();
};

export const MicLost: Story = {
  args: ONE("mic-lost"),
  play: async ({ args, canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Your mic stopped."),
    ).toBeVisible();
    await expectOneAction(
      canvasElement,
      "Reconnect mic",
      firstAction(args.alerts),
    );
  },
};

export const NoAudio: Story = {
  args: ONE("no-audio"),
  play: async ({ args, canvasElement }) => {
    await expect(
      within(canvasElement).getByText("No sound is reaching the recorder."),
    ).toBeVisible();
    await expectOneAction(canvasElement, "Check mic", firstAction(args.alerts));
  },
};

export const StorageFailed: Story = {
  args: ONE("storage-failed"),
  play: async ({ args, canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        "This device couldn't save the recording.",
      ),
    ).toBeVisible();
    await expectOneAction(
      canvasElement,
      "Retry recording",
      firstAction(args.alerts),
    );
  },
};

export const SavingFailed: Story = {
  args: ONE("saving-failed"),
  play: async ({ args, canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Saving stopped."),
    ).toBeVisible();
    await expectOneAction(
      canvasElement,
      "Resume saving",
      firstAction(args.alerts),
    );
  },
};

export const SavingFailedWithCopy: Story = {
  args: ONE("saving-failed", { onSecondaryAction: fn() }),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("button")).toHaveLength(2);
    await userEvent.click(canvas.getByRole("button", { name: "Save a copy" }));
    await expect(args.alerts?.[0]?.onSecondaryAction).toHaveBeenCalledOnce();
    await userEvent.click(
      canvas.getByRole("button", { name: "Resume saving" }),
    );
    await expect(args.alerts?.[0]?.onAction).toHaveBeenCalledOnce();
  },
};

export const Recovery: Story = {
  args: ONE("recovery"),
  play: async ({ args, canvasElement }) => {
    await expect(
      within(canvasElement).getByText("We found part of your recording."),
    ).toBeVisible();
    await expectOneAction(
      canvasElement,
      "Finish saving",
      firstAction(args.alerts),
    );
  },
};

export const HostOffline: Story = {
  args: ONE("host-offline", { name: "Rosa" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Rosa dropped. You're still recording on this device."),
    ).toBeVisible();
    // No action: the recording is fine, so there is nothing to press.
    await expect(canvas.queryAllByRole("button")).toHaveLength(0);
  },
};

export const MonitorFailed: Story = {
  args: ONE("monitor-failed"),
  play: async ({ args, canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        "You can't hear the room. Recording is fine.",
      ),
    ).toBeVisible();
    await expectOneAction(canvasElement, "Retry", firstAction(args.alerts));
  },
};

export const RoomTone: Story = {
  args: ONE("room-tone", { onSecondaryAction: fn() }),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Record 1 minute of room tone."),
    ).toBeVisible();
    await expect(canvas.getAllByRole("button")).toHaveLength(2);
    await userEvent.click(canvas.getByRole("button", { name: "Skip" }));
    await expect(args.alerts?.[0]?.onSecondaryAction).toHaveBeenCalledOnce();
    await userEvent.click(
      canvas.getByRole("button", { name: "Record room tone" }),
    );
    await expect(args.alerts?.[0]?.onAction).toHaveBeenCalledOnce();
  },
};

export const RoomToneCapturing: Story = {
  args: ONE("room-tone-capturing", {
    message: "Stay quiet · 0:42",
    progress: 0.3,
    onSecondaryAction: fn(),
  }),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Stay quiet · 0:42")).toBeVisible();
    await expect(
      canvas.getByRole("progressbar", { name: "Room tone" }),
    ).toHaveAttribute("aria-valuenow", "30");
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await expect(args.alerts?.[0]?.onSecondaryAction).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: "End early" }));
    await expect(args.alerts?.[0]?.onAction).toHaveBeenCalledOnce();
  },
};

export const Clipping: Story = {
  args: { alerts: [{ kind: "clipping" }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("You're clipping. Move back a little."),
    ).toBeVisible();
    await expect(canvas.queryAllByRole("button")).toHaveLength(0);
  },
};

export const Muted: Story = {
  args: { alerts: [{ kind: "muted" }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("You're muted.")).toBeVisible();
    await expect(canvas.queryAllByRole("button")).toHaveLength(0);
  },
};

export const Connecting: Story = {
  args: ONE("connecting"),
  play: async ({ args, canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Still connecting…"),
    ).toBeVisible();
    await expectOneAction(canvasElement, "Retry", firstAction(args.alerts));
  },
};

export const Generic: Story = {
  args: ONE("generic", {
    message: "The room closed while you were recording.",
  }),
  play: async ({ args, canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        "The room closed while you were recording.",
      ),
    ).toBeVisible();
    await expectOneAction(canvasElement, "Dismiss", firstAction(args.alerts));
  },
};

export const Notice: Story = {
  args: ONE("notice", {
    message:
      "Recovered 1 partial segment. Download your full-quality recording to keep a copy.",
    onAction: undefined,
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Recovered 1 partial segment/)).toBeVisible();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const Empty: Story = {
  args: { alerts: [] },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole("status");
    await expect(region).toBeEmptyDOMElement();
  },
};

const STACK = [
  { kind: "clipping" as const },
  {
    kind: "generic" as const,
    message: "The room closed while you were recording.",
  },
  { kind: "no-audio" as const, onAction: fn() },
  { kind: "mic-lost" as const, onAction: fn() },
];

export const Stacked: Story = {
  args: { alerts: STACK },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Your mic stopped.")).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "3 more alerts" }),
    ).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(
      canvas.getByRole("button", { name: "3 more alerts" }),
    );
    await expect(
      canvas.getByRole("button", { name: "3 more alerts" }),
    ).toHaveAttribute("aria-expanded", "true");
    const items = canvas.getAllByRole("listitem");
    await expect(items).toHaveLength(3);
    await expect(items[0]).toHaveTextContent(
      "No sound is reaching the recorder.",
    );
    await expect(items[1]).toHaveTextContent(
      "You're clipping. Move back a little.",
    );
    await expect(items[2]).toHaveTextContent(
      "The room closed while you were recording.",
    );
  },
};

export const PhoneWidth: Story = {
  globals: { viewport: { value: "mobile360", isRotated: false } },
  // The default decorator caps the width at 22.5rem, which would hide the 360 container.
  decorators: [],
  render: () => (
    <div
      style={{
        inlineSize: "22.5rem",
        maxInlineSize: "100%",
        paddingInline: "var(--space-5)",
        boxSizing: "border-box",
      }}
    >
      <RoomAlert
        alerts={[
          {
            kind: "generic",
            message:
              "The room closed while you were recording, so the take was kept on this device.",
            onAction: fn(),
          },
        ]}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toBeInTheDocument();
    const slot = canvasElement.querySelector<HTMLElement>(
      ".sys-room-alert-slot",
    );
    // jsdom has no layout, so the width check is skipped there.
    if (slot && slot.clientWidth > 0) {
      await expect(slot.scrollWidth).toBeLessThanOrEqual(slot.clientWidth + 1);
    }
  },
};

export const DarkPhone: Story = {
  ...PhoneWidth,
  globals: {
    theme: "dark",
    viewport: { value: "mobile360", isRotated: false },
  },
};
