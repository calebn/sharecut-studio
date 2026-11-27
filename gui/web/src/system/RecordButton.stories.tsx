import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { HOLD_TO_STOP_MS, RecordButton } from "./RecordButton";

const meta: Meta<typeof RecordButton> = {
  title: "System/RecordButton",
  component: RecordButton,
  tags: ["autodocs"],
  args: { face: "idle", onStart: fn(), onStop: fn() },
  decorators: [
    (Story) => (
      <div
        style={{
          padding: "var(--space-8) var(--space-6) var(--space-6)",
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
        component: `The one control that records, 64 px round. A record-red circle starts a take or resumes a paused one. While live it is a square in a ring: hold it for ${HOLD_TO_STOP_MS} ms and the ring fills, then the take stops. While live, a small "Hold to stop" caption always shows under it. Letting go early cancels, and the caption turns bold and primary colour for two seconds with a short shake. Keyboard and assistive tech cannot hold, so Enter or Space asks first with Keep recording focused; the button's description says so, and that holding stops with a pointer.\n\n**Motion.** The ring fill is a linear transition over the hold time, only when the system allows motion. The stop is timed in code, so it completes the same with reduced motion. The caption's shake is a short translate bump, only when the system allows motion; reduced-motion users get the colour and weight change without movement. Later: a pulse on the live face.`,
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof RecordButton>;

export const Idle: Story = {
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Record" }),
    );
    await expect(args.onStart).toHaveBeenCalledTimes(1);
  },
};

export const Live: Story = { args: { face: "live" } };

export const Paused: Story = {
  args: { face: "paused" },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Resume recording" }),
    );
    await expect(args.onStart).toHaveBeenCalledTimes(1);
  },
};

export const Holding: Story = {
  args: { face: "live" },
  play: async ({ args, canvasElement }) => {
    const button = within(canvasElement).getByRole("button", {
      name: "Stop take",
    });
    await userEvent.pointer({ keys: "[MouseLeft>]", target: button });
    await expect(button).toHaveAttribute("data-holding");
    await waitFor(() => expect(args.onStop).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });
  },
};

export const ReleasedEarly: Story = {
  args: { face: "live" },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", { name: "Stop take" });
    await userEvent.pointer([
      { keys: "[MouseLeft>]", target: button },
      { keys: "[/MouseLeft]" },
    ]);
    await expect(canvas.getByRole("status")).toHaveTextContent("Hold to stop");
    await expect(
      canvasElement.querySelector(".sys-record-hint"),
    ).toHaveAttribute("data-nudge");
    await expect(args.onStop).not.toHaveBeenCalled();
  },
};

export const RestingCaption: Story = {
  args: { face: "live" },
  play: async ({ canvasElement }) => {
    const caption = canvasElement.querySelector(".sys-record-hint");
    await expect(caption).toHaveTextContent("Hold to stop");
    await expect(caption).not.toHaveAttribute("data-nudge");
    await expect(
      within(canvasElement).getByRole("status"),
    ).toBeEmptyDOMElement();
  },
};

export const TapNudge: Story = {
  args: { face: "live" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", { name: "Stop take" });
    await userEvent.pointer([
      { keys: "[MouseLeft>]", target: button },
      { keys: "[/MouseLeft]" },
    ]);
    await expect(
      canvasElement.querySelector(".sys-record-hint"),
    ).toHaveAttribute("data-nudge");
    await expect(canvas.getByRole("status")).toHaveTextContent("Hold to stop");
    const describedBy = button.getAttribute("aria-describedby") ?? "";
    await expect(
      canvasElement.ownerDocument.getElementById(describedBy),
    ).toHaveTextContent("Enter or Space");
  },
};

export const KeyboardConfirm: Story = {
  args: { face: "live" },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByRole("button", { name: "Stop take" }).focus();
    await userEvent.keyboard("{Enter}");
    await expect(
      canvas.getByRole("button", { name: "Keep recording" }),
    ).toHaveFocus();
    await expect(args.onStop).not.toHaveBeenCalled();
  },
};

export const Busy: Story = {
  args: { face: "idle", busy: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Record" }),
    ).toBeDisabled();
  },
};

export const DisabledWithReason: Story = {
  args: { face: "idle", disabledReason: "Waiting for Jon to join" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Record" }),
    ).toHaveAttribute("title", "Waiting for Jon to join");
  },
};
