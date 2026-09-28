import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { sampleTrack } from "../test/fixtures";
import { trackHasSourceAudio } from "../utils/projectMedia";
import { TrackHeaderView } from "./TrackHeaderView";
import { TrackMuteSoloButtonsView } from "./TrackMuteSoloButtonsView";

const exampleTrack = sampleTrack({
  id: "mira-voice",
  label: "Mira voice",
  speaker: "Mira",
  gain_db: -3,
  fx_count: 2,
});
const actions = { onMute: fn(), onSolo: fn() };

const meta: Meta<typeof TrackHeaderView> = {
  title: "Templates/TrackHeader",
  component: TrackHeaderView,
  tags: ["autodocs"],
  decorators: [
    (Story, context) => (
      <div
        className={`daw-shell${context.parameters.trackHeaderPhone ? " daw-shell--phone" : ""} timeline-area`}
        style={{
          width: context.parameters.trackHeaderPhone ? "360px" : "48rem",
        }}
      >
        <div className="track-headers">
          <Story />
        </div>
      </div>
    ),
  ],
  args: {
    track: exampleTrack,
    trackIndex: 0,
    selected: false,
    muted: false,
    stemClass: "fresh",
    wholeReasons: [],
    hasRegional: false,
    headerHighlight: false,
    dropHighlight: false,
    dragging: false,
    dropEdge: null,
    mayReorder: false,
    mixer: (
      <TrackMuteSoloButtonsView
        trackId={exampleTrack.id}
        trackLabel={exampleTrack.label}
        muteState="off"
        solo={false}
        editsMix
        {...actions}
      />
    ),
    onSelect: fn(),
    onHandleDragStart: fn(),
    onReorderDragEnd: fn(),
    onDragOver: fn(),
    onDrop: fn(),
  },
  argTypes: {
    mixer: { control: false, table: { disable: true } },
  },
};
export default meta;
type Story = StoryObj<typeof TrackHeaderView>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Open track details, Mira voice" }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.getByText("Mira voice")).toBeVisible();
    await expect(canvas.getByText("dialogue · Mira")).toBeVisible();
    await expect(canvas.getByText("FX 2")).toBeVisible();
    await expect(canvas.getByText("Out −3.0 dB")).toBeVisible();
  },
};

export const Selected: Story = {
  args: { selected: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", {
        name: "Open track details, Mira voice",
      }),
    ).toHaveAttribute("aria-expanded", "true");
  },
};

export const SavedMute: Story = {
  args: {
    muted: true,
    mixer: (
      <TrackMuteSoloButtonsView
        trackId={exampleTrack.id}
        trackLabel={exampleTrack.label}
        muteState="saved"
        solo={false}
        editsMix
        {...actions}
      />
    ),
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Mute Mira voice" }),
    ).toHaveAttribute("data-mute-state", "saved");
  },
};

export const ListenMuteAndSolo: Story = {
  args: {
    muted: true,
    mixer: (
      <TrackMuteSoloButtonsView
        trackId={exampleTrack.id}
        trackLabel={exampleTrack.label}
        muteState="listen"
        solo
        editsMix={false}
        {...actions}
      />
    ),
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Solo Mira voice" }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};

export const Soloed: Story = {
  args: {
    mixer: (
      <TrackMuteSoloButtonsView
        trackId={exampleTrack.id}
        trackLabel={exampleTrack.label}
        muteState="off"
        solo
        editsMix
        {...actions}
      />
    ),
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Solo Mira voice" }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};

export const ImpliedMute: Story = {
  args: {
    mixer: (
      <TrackMuteSoloButtonsView
        trackId={exampleTrack.id}
        trackLabel={exampleTrack.label}
        muteState="implied"
        solo={false}
        editsMix
        {...actions}
      />
    ),
  },
  play: async ({ canvasElement }) => {
    const mute = within(canvasElement).getByRole("button", {
      name: "Mute Mira voice",
    });
    await expect(mute).toHaveAttribute("data-mute-state", "implied");
    await expect(mute.title).toContain("soloed another track");
  },
};

export const StaleStem: Story = {
  args: {
    stemClass: "stale",
    wholeReasons: ["fx"],
    headerHighlight: true,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("img", { name: "Stem out of date" }),
    ).toBeInTheDocument();
  },
};

export const EmptyTrack: Story = {
  args: {
    track: sampleTrack({
      id: "blank-lane",
      label: "Empty lane",
      duration_sec: 0,
      media_path: null,
      has_source_audio: false,
      stem_is_fresh: false,
      fx_count: 0,
    }),
    stemClass: "",
    mixer: (
      <TrackMuteSoloButtonsView
        trackId="blank-lane"
        trackLabel="Empty lane"
        muteState="off"
        solo={false}
        editsMix
        {...actions}
      />
    ),
  },
  play: async ({ canvasElement, args }) => {
    await expect(trackHasSourceAudio(args.track)).toBe(false);
    await expect(canvasElement.querySelector(".stem-status")).toBeNull();
    await expect(
      canvasElement.querySelector(
        '[data-presence-anchor="track:blank-lane:mute"]',
      ),
    ).toBeInTheDocument();
  },
};

export const ReorderTarget: Story = {
  args: { mayReorder: true, dragging: false, dropEdge: "after" },
  play: async ({ canvasElement }) => {
    const grip = within(canvasElement).getByRole("button", {
      name: "Reorder track Mira voice",
    });
    await expect(grip).toHaveAttribute("draggable", "true");
    await expect(grip).not.toHaveAttribute("tabindex");
    await expect(grip.title).toContain("↑");
    await expect(
      canvasElement.querySelector(
        ".track-header-row.drop-after:not(.dragging)",
      ),
    ).toBeInTheDocument();
  },
};

export const SpeakerMatchesName: Story = {
  args: {
    track: sampleTrack({
      id: "mira",
      label: "Mira",
      speaker: "Mira",
      fx_count: 0,
    }),
    mixer: (
      <TrackMuteSoloButtonsView
        trackId="mira"
        trackLabel="Mira"
        muteState="off"
        solo={false}
        editsMix
        {...actions}
      />
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("dialogue")).toBeVisible();
    await expect(canvas.queryByText("dialogue · Mira")).toBeNull();
  },
};

export const PhoneWidth: Story = {
  parameters: { ...recordMobileViewport.parameters, trackHeaderPhone: true },
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".track-chip")).toHaveTextContent(
      "MV",
    );
  },
};
