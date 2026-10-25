import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { AccessEndedView } from "./AccessEndedView";

const meta: Meta<typeof AccessEndedView> = {
  title: "Templates/AccessEnded",
  component: AccessEndedView,
  parameters: { layout: "fullscreen" },
  args: {
    inviteClosed: false,
    captureSettled: true,
    keeperActions: {
      busy: false,
      error: null,
      notice: null,
      download: fn(),
      recover: fn(),
    },
  },
};

export default meta;
type Story = StoryObj<typeof AccessEndedView>;

export const Ended: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Recover full-quality recording" }),
    );
    await expect(args.keeperActions.recover).toHaveBeenCalledOnce();
  },
};

export const InviteClosed: Story = {
  args: { inviteClosed: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("heading", {
        name: "Invite link closed",
      }),
    ).toBeVisible();
  },
};

export const Finishing: Story = {
  args: { captureSettled: false },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Finishing your full-quality recording…"),
    ).toBeVisible();
  },
};

export const Recovering: Story = {
  args: {
    keeperActions: {
      busy: true,
      error: null,
      notice: null,
      download: fn(),
      recover: fn(),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", {
        name: "Download full-quality recording",
      }),
    ).toBeDisabled();
  },
};

export const RecoveryFailed: Story = {
  args: {
    keeperActions: {
      busy: false,
      error: "The local recording could not be read.",
      notice: null,
      download: fn(),
      recover: fn(),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("The local recording could not be read."),
    ).toBeVisible();
  },
};

export const Recovered: Story = {
  args: {
    keeperActions: {
      busy: false,
      error: null,
      notice:
        "Recovered 2 partial segments. Saving to the project will resume.",
      download: fn(),
      recover: fn(),
    },
  },
};
