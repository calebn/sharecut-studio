import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { DialogLauncher } from "../test/DialogLauncher";
import {
  registryModels,
  UNSUPPORTED_TOOLS,
  unsupportedModels,
  withModels,
} from "../test/modelsStory";
import { openDialogByLauncher } from "../test/storyDialog";
import { ModelsSheet } from "./ModelsSheet";

const openSheet = (canvasElement: HTMLElement) =>
  openDialogByLauncher(canvasElement, {
    launcherName: "Open models",
    dialogName: "Models",
  });

const meta: Meta<typeof ModelsSheet> = {
  title: "Stages/Settings/ModelsSheet",
  component: ModelsSheet,
  tags: ["autodocs"],
  decorators: [withModels],
  parameters: {
    ...isolatedStoryParameters,
    layout: "padded",
    docs: {
      ...isolatedStoryParameters.docs,
      description: {
        component:
          "One Model need row per capability, worded by what it does: Transcription, Word timing, Speaker split, Noise reduction. A 420 px sheet on the right of a desktop, a full-height bottom sheet on a phone. Each row acts as it changes (Get, a progress ring with cancel); there is no Apply. Transcription carries the Fast / Balanced / Best size control, and choosing a size never opens a dialog.",
      },
    },
  },
  render: (_args, context) => (
    <DialogLauncher
      label="Open models"
      initiallyOpen={context.viewMode === "story"}
    >
      {(open, close) => <ModelsSheet open={open} onClose={close} />}
    </DialogLauncher>
  ),
};

export default meta;
type Story = StoryObj<typeof ModelsSheet>;

export const FreshInstall: Story = {
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = await openSheet(canvasElement);
    await expect(
      within(sheet).getAllByRole("button", { name: /^Get / }),
    ).toHaveLength(4);
    await expect(
      within(sheet).getByRole("button", { name: /^Best/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(
      within(sheet).getByRole("button", { name: /^Balanced/ }),
    );
  },
};

export const UnsupportedDevice: Story = {
  parameters: {
    models: { models: unsupportedModels(), tools: UNSUPPORTED_TOOLS },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = await openSheet(canvasElement);
    await expect(
      within(sheet).getByText(
        "ShareCut can't process audio on this device yet.",
      ),
    ).toBeVisible();
    await expect(
      within(sheet).queryByRole("button", { name: /^Get / }),
    ).toBeNull();
    await expect(
      within(sheet).queryByRole("group", { name: "Size" }),
    ).toBeNull();
  },
};

export const UnsupportedDevicePhone: Story = {
  ...UnsupportedDevice,
  globals: { viewport: { value: "mobile360", isRotated: false } },
};

export const Mixed: Story = {
  parameters: {
    models: {
      models: registryModels({
        whisper: { kind: "installed" },
        rnnoise: { kind: "update_needed" },
        "speaker-ecapa": {
          kind: "failed",
          failure: {
            kind: "network",
            plain: "Couldn't reach the download server. Check your connection.",
          },
        },
      }),
    },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = await openSheet(canvasElement);
    await expect(
      within(sheet).queryByRole("button", { name: "Update Noise reduction" }),
    ).toBeNull();
    await userEvent.click(
      within(sheet).getByRole("button", { name: "More for Noise reduction" }),
    );
    await expect(
      within(canvasElement.ownerDocument.body).getByRole("menuitem", {
        name: "Update Noise reduction",
      }),
    ).toBeEnabled();
    await userEvent.keyboard("{Escape}");
    await expect(
      within(sheet).getByRole("button", { name: "Try again Speaker split" }),
    ).toBeEnabled();
  },
};

export const Downloading: Story = {
  parameters: {
    models: {
      models: registryModels({
        whisper: {
          kind: "downloading",
          bytes: 420_000_000,
          total: 1_600_000_000,
        },
      }),
      busy: true,
    },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = await openSheet(canvasElement);
    await expect(within(sheet).getByText("420 MB of 1.6 GB")).toBeVisible();
    await expect(
      within(sheet).getByRole("button", { name: "Get Noise reduction" }),
    ).toBeDisabled();
  },
};

export const Failed: Story = {
  parameters: {
    models: {
      models: registryModels({
        whisper: {
          kind: "failed",
          failure: {
            kind: "disk",
            plain:
              "There isn't enough free disk space. Free some and try again.",
          },
        },
      }),
    },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = await openSheet(canvasElement);
    await expect(
      within(sheet).getByRole("button", { name: "Try again Transcription" }),
    ).toBeEnabled();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: "mobile360", isRotated: false } },
  parameters: {
    models: {
      models: registryModels({ whisper: { kind: "installed" } }),
    },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = await openSheet(canvasElement);
    await expect(within(sheet).getByText("Installed · 1.6 GB")).toBeVisible();
  },
};
