import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { DAMAGED, HEALTHY, MULTI_VERSION, segment } from "../segments/fixtures";
import {
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { ApiError } from "../utils/apiError";
import { HEALTHY as SHOW_KIT, MULTI_VERSION as SUMMER } from "./fixtures";
import { KitEditorSheet } from "./KitEditorSheet";

const OUTRO = segment({
  id: "outro-4d2e",
  name: "Sign off",
  kind: "outro",
  clips: [{ audio: "o.flac", offset_sec: 0, duration_sec: 20 }],
});

const meta: Meta<typeof KitEditorSheet> = {
  title: "Stages/Home/KitEditorSheet",
  component: KitEditorSheet,
  tags: ["autodocs"],
  args: {
    open: true,
    segments: [HEALTHY, MULTI_VERSION, OUTRO, DAMAGED],
    kits: [SHOW_KIT, SUMMER],
    onClose: fn(),
    onSaved: fn(),
    onSegmentsChanged: fn(),
    send: fn(async () => ({
      status: "added" as const,
      id: "weekly-1",
      version: 1,
    })),
  },
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The New kit sheet, opened from the Kits section on Home and in the Segment library sheet (host only). A Name field says whether the name makes a new kit or the next version of one with that name. Below it the segments in this kit, in the order they apply: each row has Start or End (an intro starts at Start, every other kind at End), Move up and Move down (disabled at the ends with the reason) and Remove, all 44 px. Start entries apply one after another, each at the very start, so a Start entry after another lands ahead of it and the row says so. Under that, the segments in the library to add; one that can't be read is left out and counted. Save kit is off until there is a segment, and while it runs everything holds still. A refusal is explained inside the sheet, which stays open. It is a side sheet on a desktop and a bottom sheet on a phone.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof KitEditorSheet>;

const sheet = () => within(document.body);

async function addSegments(...names: string[]) {
  for (const name of names) {
    await userEvent.click(
      await sheet().findByRole("button", { name: `Add ${name}` }),
    );
  }
}

export const Empty: Story = {
  tags: ["storybook-only"],
  play: async () => {
    await expect(await sheet().findByLabelText("Name")).toBeVisible();
    await expect(
      sheet().getByText(/Add the segments this kit puts/),
    ).toBeVisible();
    await expect(
      sheet().getByRole("button", { name: "Save kit" }),
    ).toBeDisabled();
    await expect(
      sheet().getByText("1 segment can't be read and isn't listed."),
    ).toBeVisible();
  },
};

export const Filled: Story = {
  tags: ["storybook-only"],
  play: async () => {
    await addSegments("Cold open", "Acme sponsor read", "Sign off");
    await userEvent.type(await sheet().findByLabelText("Name"), "Weekly");
    await expect(
      sheet().getByRole("list", { name: "Kit segments" }),
    ).toBeVisible();
    await expect(sheet().getByText("Saves a new kit.")).toBeVisible();
    await expect(
      sheet().getByRole("button", { name: "Save kit" }),
    ).toBeEnabled();
  },
};

export const StartOrderWarning: Story = {
  tags: ["storybook-only"],
  play: async () => {
    await addSegments("Cold open", "Cold open");
    await expect(
      sheet().getByText(/Start entries apply one after another/),
    ).toBeVisible();
  },
};

export const NewVersion: Story = {
  tags: ["storybook-only"],
  play: async () => {
    await addSegments("Cold open");
    await userEvent.type(await sheet().findByLabelText("Name"), "Show Kit");
    await expect(
      sheet().getByText(
        "Saves to the existing kit Show Kit if anything changed. The earlier version is kept.",
      ),
    ).toBeVisible();
  },
};

export const NameError: Story = {
  tags: ["storybook-only"],
  play: async () => {
    await addSegments("Cold open");
    await userEvent.type(await sheet().findByLabelText("Name"), "日本");
    await userEvent.click(sheet().getByRole("button", { name: "Save kit" }));
    await expect(
      await sheet().findByText("Use at least one letter or digit from a to z."),
    ).toBeVisible();
  },
};

export const Saving: Story = {
  tags: ["storybook-only"],
  args: { send: fn(() => new Promise<never>(() => {})) },
  play: async ({ args }) => {
    await addSegments("Cold open");
    await userEvent.type(await sheet().findByLabelText("Name"), "Weekly");
    await userEvent.click(sheet().getByRole("button", { name: "Save kit" }));
    await expect(await sheet().findByText("Saving the kit…")).toBeVisible();
    await expect(args.send).toHaveBeenCalledOnce();
    await expect(
      sheet().getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
  },
};

export const ServerError: Story = {
  tags: ["storybook-only"],
  args: {
    send: fn(async () => {
      throw new ApiError("busy", "kit_busy", 409);
    }),
  },
  play: async () => {
    await addSegments("Cold open");
    await userEvent.type(await sheet().findByLabelText("Name"), "Weekly");
    await userEvent.click(sheet().getByRole("button", { name: "Save kit" }));
    await expect(
      await sheet().findByText(
        "Another action is using the kit library. Try again.",
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(sheet().getByRole("button", { name: "Save kit" })).toBeEnabled(),
    );
  },
};

export const NoSegments: Story = {
  tags: ["storybook-only"],
  args: { segments: [] },
  play: async () => {
    await expect(
      await sheet().findByText(/Save a segment from an episode first/),
    ).toBeVisible();
  },
};

export const Phone: Story = {
  tags: ["storybook-only"],
  globals: { viewport: { value: "mobile360", isRotated: false } },
  play: async () => {
    await addSegments("Cold open", "Cold open", "Sign off");
    await userEvent.type(await sheet().findByLabelText("Name"), "Weekly");
    await expect(
      sheet().getByRole("button", { name: "Save kit" }),
    ).toBeEnabled();
  },
};
