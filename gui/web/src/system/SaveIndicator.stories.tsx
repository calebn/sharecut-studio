import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { SaveIndicator } from "./SaveIndicator";

const meta: Meta<typeof SaveIndicator> = {
  title: "System/SaveIndicator",
  component: SaveIndicator,
  tags: ["autodocs"],
  args: { state: "saved", onRetry: fn(), onDownload: fn() },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)" }}>
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
          'A small glyph after the title. Saved shows nothing, or a check for 2 s after a save. Saving is a hollow ring, Offline an amber slashed cloud with a count, Away the same cloud with "Can\'t reach the host" or "You\'re offline" (an open page whose host or device stopped answering; one status sentence, "This page keeps trying."), Unreachable a hollow amber cloud with "Saved copy" (a guest reading the cached copy because the host cannot be reached), Unkept the same cloud with "Not kept on this device" (a guest browser that blocks or has no room for the saved copy; one sentence in the title and for assistive tech, no alert), Failed a red octagon with Retry and Download a copy. Every state also has a text name for assistive tech.\n\n**Motion.** The check fades out after 2 s with `--motion-state` in the animation pass; the 2 s hold is the caller\'s.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SaveIndicator>;

export const Saved: Story = {
  play: async ({ canvasElement }) => {
    const status = within(canvasElement).getByRole("status");
    await expect(status).toHaveTextContent("Saved");
    await expect(status.querySelector("svg")).toBeNull();
  },
};
export const JustSaved: Story = {
  args: { justSaved: true },
  play: async ({ canvasElement }) => {
    const status = within(canvasElement).getByRole("status");
    await expect(status).toHaveTextContent("Saved");
    await expect(status.querySelector("svg")).not.toBeNull();
  },
};
export const Saving: Story = {
  args: { state: "saving" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "Saving",
    );
  },
};
export const Offline: Story = {
  args: { state: "offline", waiting: 2 },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "2 waiting",
    );
  },
};
export const UnkeptBlocked: Story = {
  args: { state: "unkept", storageCause: "blocked" },
  play: async ({ canvasElement }) => {
    const light = canvasElement.querySelector(".sys-save");
    await expect(light).toHaveTextContent("Not kept on this device");
    await expect(light).toHaveAttribute(
      "title",
      "Your browser isn't letting this page keep a saved copy. The page still works while the host answers. If the host stops, what you write here is lost when you close the page.",
    );
    await expect(within(canvasElement).queryByRole("alert")).toBeNull();
  },
};
export const UnkeptFull: Story = {
  args: { state: "unkept", storageCause: "full" },
  play: async ({ canvasElement }) => {
    const light = canvasElement.querySelector(".sys-save");
    await expect(light).toHaveTextContent("Not kept on this device");
    await expect(light).toHaveAttribute(
      "title",
      "This device has no room to keep a saved copy. The page still works while the host answers. If the host stops, what you write here is lost when you close the page.",
    );
    await expect(within(canvasElement).queryByRole("alert")).toBeNull();
  },
};
export const AwayHost: Story = {
  args: { state: "away", cause: "host" },
  play: async ({ canvasElement }) => {
    const status = within(canvasElement).getByRole("status");
    await expect(status).toHaveTextContent("Can't reach the host");
    await expect(status).toHaveAttribute(
      "title",
      "Can't reach the host. This page keeps trying.",
    );
  },
};
export const AwayDevice: Story = {
  args: { state: "away", cause: "device" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "You're offline",
    );
  },
};
export const AwayWithEditsWaiting: Story = {
  args: { state: "away", cause: "host", waiting: 2 },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "Can't reach the host · 2 waiting",
    );
  },
};
export const AwayCompact: Story = {
  args: { state: "away", cause: "device", compact: true, waiting: 2 },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveClass(
      "sys-save--compact",
    );
  },
};
export const Unreachable: Story = {
  args: { state: "unreachable", waiting: 2 },
  play: async ({ canvasElement }) => {
    const status = within(canvasElement).getByRole("status");
    await expect(status).toHaveTextContent("Saved copy · 2 waiting");
    await expect(status).toHaveTextContent("It is read-only.");
  },
};
export const UnreachableNothingWaiting: Story = {
  args: { state: "unreachable" },
  play: async ({ canvasElement }) => {
    const status = within(canvasElement).getByRole("status");
    await expect(status).toHaveTextContent("Saved copy");
    await expect(status).not.toHaveTextContent("waiting");
  },
};
export const UnreachableCompact: Story = {
  args: { state: "unreachable", compact: true, waiting: 2 },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveClass(
      "sys-save--compact",
    );
  },
};
export const Failed: Story = {
  args: { state: "failed" },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    // The text is announced; the controls are not inside a live region.
    const alert = canvas.getByRole("alert");
    await expect(alert).toHaveTextContent("Save failed");
    await expect(alert.querySelector("button")).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: /Retry/ }));
    await expect(args.onRetry).toHaveBeenCalledOnce();
    await userEvent.click(
      canvas.getByRole("button", { name: "Download a copy" }),
    );
    await expect(args.onDownload).toHaveBeenCalledOnce();
  },
};
export const FailedCompact: Story = {
  args: { state: "failed", compact: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: /Retry/ })).toBeVisible();
    // CSS takes Download a copy out of the compact form; the class is the contract.
    await expect(
      canvas.getByRole("group", { name: "Save status" }),
    ).toHaveClass("sys-save--compact");
  },
};
