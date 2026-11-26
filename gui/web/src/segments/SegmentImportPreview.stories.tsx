import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import {
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { waiting } from "./fixtures";
import { SegmentImportPreview } from "./SegmentImportPreview";

const meta: Meta<typeof SegmentImportPreview> = {
  title: "Stages/Home/SegmentImportPreview",
  component: SegmentImportPreview,
  tags: ["autodocs"],
  args: {
    state: { phase: "preview", preview: waiting(), notice: null },
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
          "What a chosen or dropped segment file would do, shown before anything is added to the library: the name, kind and length, a Play button that plays the waiting file's own audio, and one line for the outcome (Adds Intro, Adds as Intro v2, Already in your library). Add and Cancel sit in the footer; a file already in the library offers Show in library instead of Add. A file the service refuses shows its message in the card and adds nothing. It is a centered card on a desktop and a bottom sheet on a phone.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SegmentImportPreview>;

const card = () => within(document.body);

export const Adds: Story = {
  tags: ["storybook-only"],
  play: async () => {
    await expect(await card().findByText("Adds Cold open")).toBeVisible();
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
      preview: waiting({ outcome: "new_version", version: 2 }),
      notice: null,
    },
  },
  play: async () => {
    await expect(await card().findByText("Adds as Cold open v2")).toBeVisible();
  },
};

export const AlreadyInLibrary: Story = {
  tags: ["storybook-only"],
  args: {
    state: {
      phase: "preview",
      preview: waiting({ outcome: "unchanged", existing_id: "intro-9f3a" }),
      notice: null,
    },
  },
  play: async () => {
    await expect(
      await card().findByText("Already in your library"),
    ).toBeVisible();
    await expect(
      card().getByRole("button", { name: "Show in library" }),
    ).toBeVisible();
  },
};

export const Checking: Story = {
  tags: ["storybook-only"],
  args: { state: { phase: "uploading", fileName: "cold-open.sharecutseg" } },
  play: async () => {
    await expect(
      await card().findByText("Checking cold-open.sharecutseg…"),
    ).toBeVisible();
  },
};

export const Adding: Story = {
  tags: ["storybook-only"],
  args: { state: { phase: "committing", preview: waiting() } },
  play: async () => {
    await expect(
      await card().findByRole("button", { name: "Adding…" }),
    ).toBeDisabled();
  },
};

export const Refused: Story = {
  tags: ["storybook-only"],
  args: {
    state: {
      phase: "error",
      fileName: "cold-open.sharecutseg",
      message: "clip-01.flac does not match its hash in MANIFEST.sha256.",
    },
  },
  play: async () => {
    await expect(await card().findByRole("alert")).toHaveTextContent(
      "does not match its hash",
    );
  },
};

export const BusyLibrary: Story = {
  tags: ["storybook-only"],
  args: {
    state: {
      phase: "preview",
      preview: waiting(),
      notice: "The segment library is being changed by another program.",
    },
  },
};

export const Phone: Story = {
  tags: ["storybook-only"],
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
