import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { isolatedStoryParameters } from "../../storybook/storyLayout";
import { registryModels } from "../../test/modelsStory";
import { ANOTHER_DOWNLOAD_REASON } from "../activity";
import type { ModelState } from "../types";
import { ModelGateDialog, ModelGateHint, ModelGatePanel } from "./ModelGate";
import type { GatePhase, ModelGate } from "./useModelGate";

function gate(
  phase: GatePhase,
  state: ModelState,
  over: Partial<ModelGate> = {},
  blockedReason?: string,
): ModelGate {
  const view = registryModels({ "speaker-ecapa": state })[3];
  return {
    run: () => Promise.reject(new Error("The story does not run actions.")),
    prompt: {
      need: { id: view.id },
      label: view.label,
      purpose: view.purpose,
      size: view.size,
      phase,
      view,
      blockedReason,
    },
    declined: null,
    accept: fn(),
    decline: fn(),
    cancelDownload: fn(),
    openModels: fn(),
    reset: fn(),
    ...over,
  };
}

const meta: Meta<typeof ModelGateDialog> = {
  title: "Templates/Model gate",
  component: ModelGateDialog,
  parameters: { ...isolatedStoryParameters, layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof ModelGateDialog>;

const dialogName = "Download Speaker model?";

export const Ask: Story = {
  args: { gate: gate("ask", { kind: "missing" }) },
  play: async ({ args }) => {
    const dialog = await within(document.body).findByRole("dialog", {
      name: dialogName,
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Download" }),
    );
    await expect(args.gate.accept).toHaveBeenCalledOnce();
  },
};

export const AskBlocked: Story = {
  args: {
    gate: gate("ask", { kind: "missing" }, {}, ANOTHER_DOWNLOAD_REASON),
  },
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog", {
      name: dialogName,
    });
    await expect(
      within(dialog).getByRole("button", { name: "Download" }),
    ).toBeDisabled();
  },
};

export const Downloading: Story = {
  args: {
    gate: gate("downloading", {
      kind: "downloading",
      bytes: 9_000_000,
      total: 25_000_000,
    }),
  },
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog", {
      name: dialogName,
    });
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Cancel download" }),
      ).toBeVisible(),
    );
  },
};

export const Failed: Story = {
  args: {
    gate: gate("failed", {
      kind: "failed",
      failure: {
        kind: "network",
        plain:
          "Couldn't reach the download server. Check your internet connection and try again.",
      },
    }),
  },
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog", {
      name: dialogName,
    });
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Retry" }),
      ).toBeVisible(),
    );
  },
};

export const Ready: Story = {
  args: { gate: gate("ready", { kind: "installed" }) },
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog", {
      name: dialogName,
    });
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Continue" }),
      ).toBeVisible(),
    );
  },
};

export const InsideDialog: Story = {
  render: (args) => <ModelGatePanel gate={args.gate} />,
  args: { gate: gate("ask", { kind: "missing" }) },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Manage models" }),
    ).toBeVisible();
  },
};

export const DeclinedHint: Story = {
  render: (args) => (
    <ModelGateHint gate={args.gate} actionLabel="Split speakers" />
  ),
  args: {
    gate: gate(
      "ask",
      { kind: "missing" },
      {
        prompt: null,
        declined: { id: "speaker-ecapa", label: "Speaker model" },
      },
    ),
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(/Split speakers will ask again/),
    ).toBeVisible();
  },
};
