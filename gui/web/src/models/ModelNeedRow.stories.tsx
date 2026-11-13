import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { ModelNeedRowView } from "./ModelNeedRow";

const WHISPER = {
  id: "whisper",
  variant: "large-v3-turbo",
  label: "Whisper speech model",
  size: "~1.6 GB",
};

const meta: Meta<typeof ModelNeedRowView> = {
  title: "System/ModelNeedRow",
  component: ModelNeedRowView,
  tags: ["autodocs"],
  args: {
    placement: "need",
    model: WHISPER,
    state: { kind: "missing" },
    onGet: fn(),
    onCancel: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxInlineSize: "26.25rem" }}>
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
          "The in-place answer to a step that needs a model: capability, size, Get, a progress bar with Cancel, and Manage for the Models sheet. It sits inside a Job row or a Check row and is never a modal. In the Models sheet the same row is the 64 px list row: icon, capability, 'Not installed · 360 MB', and Get, a progress ring with cancel, or a More menu with Update and Remove for an out-of-date model and Remove for an installed model. The step resumes by itself when the download lands (`useModelResume`).",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ModelNeedRowView>;

export const Needs: Story = {
  args: { onManage: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Needs the transcription model"),
    ).toBeVisible();
    await expect(canvas.getByText("1.6 GB")).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Get the transcription model" }),
    );
    await expect(args.onGet).toHaveBeenCalledOnce();
  },
};

export const Downloading: Story = {
  args: {
    state: { kind: "downloading", bytes: 420_000_000, total: 1_600_000_000 },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("420 MB of 1.6 GB")).toBeVisible();
    await expect(
      canvas.getByRole("button", {
        name: "Cancel the transcription model download",
      }),
    ).toBeVisible();
  },
};

export const Failed: Story = {
  args: {
    state: {
      kind: "failed",
      failure: {
        kind: "network",
        plain: "Couldn't reach the download server.",
      },
    },
    onManage: fn(),
  },
};

export const ListMissing: Story = {
  args: { placement: "list", model: { ...WHISPER, size: "~360 MB" } },
};

export const ListInstalled: Story = {
  args: { placement: "list", state: { kind: "installed" } },
};

export const ListDownloading: Story = {
  args: {
    placement: "list",
    state: { kind: "downloading", bytes: 420_000_000, total: 1_600_000_000 },
  },
};

const UNSUPPORTED = {
  kind: "unsupported",
  hint: "ShareCut can't transcribe audio on this device yet.",
} as const;

export const Unsupported: Story = {
  args: { state: UNSUPPORTED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("ShareCut can't transcribe audio on this device yet."),
    ).toBeVisible();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const ListUnsupported: Story = {
  args: { placement: "list", state: UNSUPPORTED },
};
