import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import {
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { MIXED_KIT, UNCHANGED_KIT, waitingKit } from "./fixtures";
import { KitImportPreview } from "./KitImportPreview";

const meta: Meta<typeof KitImportPreview> = {
  title: "Stages/Home/KitImportPreview",
  component: KitImportPreview,
  tags: ["autodocs"],
  args: {
    state: { phase: "preview", preview: waitingKit(), notice: null },
    onAdd: fn(),
    onCancel: fn(),
    onChooseAgain: fn(),
  },
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "What a chosen or dropped kit file would do, shown before anything is added: the kit's name, one line for the outcome (Adds Show Kit, Adds as Show Kit v2, Already in your library), a count of its segments, and the segments in the order the kit applies them with their kind, length, where each goes and whether it is New, a New version or Already there. There is nothing to play. Add and Cancel sit in the footer; a kit that is entirely in the library has Close only. A busy library or a failed write keeps the file and says how many segments landed, and Add finishes the job. A file the service refuses shows its message and adds nothing. It is a centered card on a desktop and a bottom sheet on a phone.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof KitImportPreview>;

const card = () => within(document.body);

export const Adds: Story = {
  tags: ["storybook-only"],
  play: async () => {
    await expect(await card().findByText("Adds Show Kit")).toBeVisible();
    await expect(
      card().getByRole("list", { name: "Kit entries" }),
    ).toBeVisible();
    await expect(
      card().getByRole("button", { name: "Add to library" }),
    ).toBeVisible();
  },
};

export const AddsAsNewVersion: Story = {
  tags: ["storybook-only"],
  args: {
    state: {
      phase: "preview",
      preview: waitingKit({ outcome: "new_version", version: 2 }),
      notice: null,
    },
  },
  play: async () => {
    await expect(await card().findByText("Adds as Show Kit v2")).toBeVisible();
  },
};

export const MixedEntries: Story = {
  tags: ["storybook-only"],
  args: { state: { phase: "preview", preview: MIXED_KIT, notice: null } },
  play: async () => {
    await expect(await card().findByText("New version v2")).toBeVisible();
    await expect(card().getByText("Already there")).toBeVisible();
    await expect(card().getByText("At 1:20")).toBeVisible();
  },
};

export const AlreadyInLibrary: Story = {
  tags: ["storybook-only"],
  args: { state: { phase: "preview", preview: UNCHANGED_KIT, notice: null } },
  play: async () => {
    await expect(
      await card().findByText("Already in your library"),
    ).toBeVisible();
    await expect(
      card().queryByRole("button", { name: "Add to library" }),
    ).toBeNull();
  },
};

export const Checking: Story = {
  tags: ["storybook-only"],
  args: { state: { phase: "uploading", fileName: "show-kit.sharecutkit" } },
  play: async () => {
    await expect(
      await card().findByText("Checking show-kit.sharecutkit…"),
    ).toBeVisible();
  },
};

export const Adding: Story = {
  tags: ["storybook-only"],
  args: { state: { phase: "committing", preview: MIXED_KIT } },
  play: async () => {
    await expect(
      await card().findByRole("button", { name: "Adding…" }),
    ).toBeDisabled();
  },
};

export const PartialRetry: Story = {
  tags: ["storybook-only"],
  args: {
    state: {
      phase: "preview",
      preview: MIXED_KIT,
      notice:
        "The segment library is being changed by another program. Added 1 of 2 segments. Choose Add to library to finish.",
    },
  },
  play: async () => {
    await expect(await card().findByRole("alert")).toHaveTextContent(
      "Added 1 of 2 segments.",
    );
    await expect(
      card().getByRole("button", { name: "Add to library" }),
    ).toBeEnabled();
  },
};

export const BusyLibrary: Story = {
  tags: ["storybook-only"],
  args: {
    state: {
      phase: "preview",
      preview: waitingKit(),
      notice: "The segment library is being changed by another program.",
    },
  },
};

export const Refused: Story = {
  tags: ["storybook-only"],
  args: {
    state: {
      phase: "error",
      fileName: "show-kit.sharecutkit",
      message:
        "seg01__clip-01.flac does not match its hash in MANIFEST.sha256.",
    },
  },
  play: async () => {
    await expect(await card().findByRole("alert")).toHaveTextContent(
      "does not match its hash",
    );
  },
};

export const TooLarge: Story = {
  tags: ["storybook-only"],
  args: {
    state: {
      phase: "error",
      fileName: "show-kit.sharecutkit",
      message: "That file is too large to import here.",
    },
  },
};

export const Phone: Story = {
  tags: ["storybook-only"],
  args: { state: { phase: "preview", preview: MIXED_KIT, notice: null } },
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
