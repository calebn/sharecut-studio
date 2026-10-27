import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { Tracks } from "./tracksDemo";
import { DEMO_TRACKS } from "./tracksFixtures";

const meta: Meta<typeof Tracks> = {
  title: "Stages/Edit/Tracks",
  component: Tracks,
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "Three tracks as the Edit timeline draws them: a header column (System/TrackHeader) beside lanes of System/Clip. The stories keep the selection, mute, solo and level that the host would: soloing one track leaves the rest with an implied mute, which dims their lanes without pressing their Mute. Clicking a clip selects it and shows its handles. On a phone the column is the 56 px avatar form and the lanes scroll sideways. A guest sees the same tracks with no clip handles and a fixed level.\n\n**Motion.** None.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Tracks>;

export const ThreeTracks: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Maya, take 2" }));
    await expect(
      canvas.getByRole("button", { name: "Maya, take 2" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.getAllByRole("slider").filter((handle) => handle.tabIndex === 0),
    ).toHaveLength(4);
    await expect(
      canvas.getByRole("button", { name: "Maya, intro" }),
    ).toHaveAttribute("aria-pressed", "false");
  },
};

export const Soloed: Story = {
  args: { selectedTrack: "anneke" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Solo Anneke de Vries" }),
    );
    await expect(
      canvas.getByRole("button", { name: "Mute Maya Okafor" }),
    ).toHaveAccessibleDescription(
      /^Mute\. Not muted: silent because you soloed/,
    );
    await expect(
      canvas.getByRole("button", { name: "Mute Anneke de Vries" }),
    ).toHaveAttribute("aria-pressed", "false");
  },
};

export const MutedAndRebuilding: Story = {
  args: {
    tracks: DEMO_TRACKS.map((track) => ({
      ...track,
      muted: track.id === "music",
      rebuilding: track.id === "anneke",
    })),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Mute Music bed" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.getByRole("button", { name: "Anneke de Vries" }),
    ).toHaveAccessibleDescription("Rebuilding");
  },
};

export const Mixer: Story = {
  args: { form: "wide", selectedClip: "Theme" },
};

export const Reordering: Story = {
  args: { reorder: { id: "anneke", state: "lifted" } },
};

export const Phone: Story = {
  args: { form: "phone", selectedClip: "Anneke, answer" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("spinbutton")).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "Anneke de Vries" }),
    ).toBeVisible();
  },
};

export const ReadOnlyGuest: Story = {
  args: {
    readOnly: true,
    selectedClip: "Maya, take 2",
    tracks: DEMO_TRACKS.map((track) => ({
      ...track,
      muted: track.id === "music",
    })),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("slider")).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "Mute Music bed" }),
    ).toHaveAttribute("aria-disabled", "true");
  },
};
