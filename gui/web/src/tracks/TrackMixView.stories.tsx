import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { initials } from "../presence/colors";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { laneColor } from "../timeline/laneColors";
import { trackMuteState } from "../utils/audio";
import { type MixTrack, TrackMixView } from "./TrackMixView";

type PreviewProps = {
  labels: readonly string[];
  listen: boolean;
  loading: boolean;
  preview: "host" | "shared-full-mix";
  savedMute: boolean;
  implied: boolean;
  onVolume: (trackId: string, db: number) => void;
  onMute: (trackId: string) => void;
  onSolo: (trackId: string) => void;
};
function ControlledMix(args: PreviewProps) {
  const [savedMutes, setSavedMutes] = useState<Record<string, boolean>>(
    args.savedMute ? { "track-1": true } : {},
  );
  const [viewerMute, setViewerMute] = useState<Record<string, boolean>>({});
  const [soloTracks, setSoloTracks] = useState<Record<string, boolean>>(
    args.implied ? { "track-0": true } : {},
  );
  const [volumes, setVolumes] = useState<Record<string, number>>({
    "track-0": -3,
  });
  const rows: MixTrack[] = args.labels.map((label, index) => {
    const id = `track-${index}`;
    return {
      id,
      label,
      initials: initials(label),
      identityColor: laneColor(index === 5 ? "music" : "dialogue", index),
      muteState: trackMuteState(
        id,
        Boolean(savedMutes[id]),
        viewerMute,
        soloTracks,
      ),
      solo: Boolean(soloTracks[id]),
      faderDb: volumes[id] ?? 0,
    };
  });
  return args.loading ? (
    <TrackMixView state="loading" />
  ) : (
    <TrackMixView
      state="ready"
      rows={rows}
      preview={args.preview}
      access={
        args.listen
          ? { kind: "listen" }
          : {
              kind: "edit",
              onVolume: (id, db) => {
                args.onVolume(id, db);
                setVolumes((value) => ({ ...value, [id]: db }));
              },
            }
      }
      onMute={(id) => {
        args.onMute(id);
        if (args.listen) {
          if (!savedMutes[id])
            setViewerMute((value) => ({ ...value, [id]: !value[id] }));
        } else setSavedMutes((value) => ({ ...value, [id]: !value[id] }));
      }}
      onSolo={(id) => {
        args.onSolo(id);
        setSoloTracks((value) => ({ ...value, [id]: !value[id] }));
      }}
    />
  );
}
const meta: Meta<PreviewProps> = {
  title: "Templates/TrackMix",
  component: ControlledMix,
  tags: ["autodocs"],
  render: (args) => <ControlledMix {...args} />,
  decorators: [
    (Story) => (
      <div
        className="daw-shell"
        style={{ width: "22.5rem", maxWidth: "100%", height: "32rem" }}
      >
        <main>
          <h1 className="sr-only">Track mix preview</h1>
          <Story />
        </main>
      </div>
    ),
  ],
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
  args: {
    labels: ["Mira voice", "Avery", "Quinn", "Rowan", "Sam", "Music bed"],
    listen: false,
    loading: false,
    preview: "host",
    savedMute: false,
    implied: false,
    onVolume: fn(),
    onMute: fn(),
    onSolo: fn(),
  },
};
export default meta;
type Story = StoryObj<PreviewProps>;
export const Phone360: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("listitem")).toHaveLength(6);
    await userEvent.click(canvas.getByRole("button", { name: "Mute Avery" }));
    await expect(
      canvas.getByRole("button", { name: "Mute Avery" }),
    ).toHaveAttribute("data-mute-state", "saved");
    await expect(args.onMute).toHaveBeenCalledWith("track-1");
    await userEvent.click(
      canvas.getByRole("button", { name: "Solo Mira voice" }),
    );
    await expect(
      canvas.getByRole("button", { name: "Solo Mira voice" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.getByRole("button", { name: "Mute Quinn" }),
    ).toHaveAttribute("data-mute-state", "implied");
  },
};
export const ReadOnly: Story = {
  args: { listen: true, savedMute: true, preview: "shared-full-mix" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("slider", { name: "Volume Mira voice" }),
    ).toBeDisabled();
    await expect(
      canvas.getByRole("slider", { name: "Volume Mira voice" }),
    ).toHaveAccessibleDescription(
      /Only the host and editors can change volume/,
    );
    await expect(
      canvas.getByRole("button", { name: "Mute Avery" }),
    ).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(
      canvas.getByRole("button", { name: "Mute Mira voice" }),
    );
    await expect(
      canvas.getByRole("button", { name: "Mute Mira voice" }),
    ).toHaveAttribute("data-mute-state", "listen");
    await expect(
      canvas.getByText(/Shared playback uses Full mix/),
    ).toBeVisible();
  },
};
export const SavedAndImplied: Story = {
  args: { savedMute: true, implied: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Mute Avery" }),
    ).toHaveAttribute("data-mute-state", "saved");
    await expect(
      canvas.getByRole("button", { name: "Mute Quinn" }),
    ).toHaveAttribute("data-mute-state", "implied");
  },
};
export const LongNames: Story = {
  args: {
    labels: [
      "Mira voice with a very long descriptive recording name",
      "Avery interviewing the guest about the whole episode",
      "Music bed",
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("slider", {
        name: "Volume Mira voice with a very long descriptive recording name",
      }),
    ).toHaveValue("-3");
  },
};
export const ManyTracks: Story = {
  args: {
    labels: Array.from({ length: 18 }, (_, index) => `Speaker ${index + 1}`),
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByRole("listitem")).toHaveLength(
      18,
    );
  },
};
export const Empty: Story = {
  args: { labels: [] },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        "No tracks yet. Add or import audio from More.",
      ),
    ).toBeVisible();
  },
};
export const Loading: Story = {
  args: { loading: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByLabelText("Loading tracks"),
    ).toHaveAttribute("aria-busy", "true");
  },
};
