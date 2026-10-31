import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { bindPlaybackMeterSource } from "../../audio/playbackMeterSource";
import { useDawStore } from "../../state/dawStore";
import {
  studioViewports,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { episode, MIRA, TOMAS } from "../../test/episodeFixture";
import { sampleTrack } from "../../test/fixtures";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import type { TrackColumnProps } from "./TrackColumn";
import { TrackColumn } from "./TrackColumn";

type Args = TrackColumnProps & { framePhone?: boolean };

const BED = "music-bed";

const tracks = [
  sampleTrack({
    id: MIRA,
    label: "Mira",
    speaker: "Mira",
    duration_sec: 120,
  }),
  sampleTrack({
    id: TOMAS,
    label: "Tomas",
    speaker: "Tomas",
    duration_sec: 120,
  }),
  sampleTrack({
    id: BED,
    label: "Music bed",
    role: "music",
    duration_sec: 120,
  }),
];

const withTracks = (patch: Record<string, Partial<(typeof tracks)[number]>>) =>
  episode({
    tracks: tracks.map((track) => ({ ...track, ...patch[track.id] })),
  });

const meta: Meta<Args> = {
  title: "Stages/Edit/TrackColumn",
  component: TrackColumn,
  beforeEach: episodeBeforeEach,
  args: { form: "default", showSoloChip: true },
  decorators: [
    withEpisode,
    (Story, context) => (
      <div
        className={`stage-frame stage-frame--${context.args.framePhone ? "phone" : "desktop"}`}
        style={{ inlineSize: "fit-content", minBlockSize: 0 }}
      >
        <div
          className="timeline-area"
          style={{ ["--lane-height" as string]: "72px", overflow: "visible" }}
        >
          <Story />
        </div>
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    viewport: { options: studioViewports },
    episode: { project: withTracks({}) },
    docs: {
      description: {
        component:
          "The Edit stage's track header column (design-system element 16 in the timeline): the corner above the headers, one `System/TrackHeader` per track in a lane-high slot, the Edit + row and the well that deselects. It wires each header to the store: Mute and Solo run the track commands, the level saves the track volume, Shift with Up or Down moves the track, a drag from the header reorders (drop on another header), and the ring follows the live playback level at about 8 Hz without redrawing the column. A stale stem hollows the ring and says why; a clip light lit in playback shows a danger ring until the Track inspector clears it.\n\nThe desktop and tablet shells use the 168 px form; the phone shell uses the 56 px avatar form, where a tap selects the track and opens its details and the mix lives in the Mix sheet. Solo on stays in the corner as the system has no part for it. Touch has no drag to reorder: use Shift with Up or Down on a keyboard, or Move up and Move down in the track's details.\n\n**Motion.** None.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<Args>;

const header = (canvas: ReturnType<typeof within>, name: string) =>
  canvas.getByRole("button", { name });

export const Desktop: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("group", { name: "Tracks" }),
    ).toBeVisible();
    for (const name of ["Mira", "Tomas", "Music bed"]) {
      await expect(header(canvas, name)).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }
    await expect(canvasElement.querySelector(".sys-track")).toHaveAttribute(
      "data-form",
      "default",
    );
  },
};

export const Tablet: Story = {
  globals: { viewport: { value: "tablet", isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("group", { name: "Tracks" }),
    ).toBeVisible();
    await expect(canvasElement.querySelector(".sys-track")).toHaveAttribute(
      "data-form",
      "default",
    );
  },
};

export const Phone: Story = {
  args: { form: "phone", showSoloChip: false, framePhone: true },
  globals: { viewport: { value: "mobile360", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("group", { name: "Tracks" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("spinbutton")).toBeNull();
    await expect(canvasElement.querySelector(".sys-track")).toHaveAttribute(
      "data-form",
      "phone",
    );
    await userEvent.click(header(canvas, "Tomas"));
    await expect(header(canvas, "Tomas")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

export const Selected: Story = {
  parameters: { episode: { selection: { kind: "track", trackId: TOMAS } } },
  play: async ({ canvasElement }) => {
    await expect(header(within(canvasElement), "Tomas")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

export const Muted: Story = {
  parameters: {
    episode: {
      project: withTracks({ [MIRA]: { muted: true } }),
      state: { viewerMute: { [TOMAS]: true } },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(header(canvas, "Mira")).toHaveAccessibleDescription(
      "Muted in the mix",
    );
    await expect(header(canvas, "Tomas")).toHaveAccessibleDescription(
      "Muted for you only",
    );
  },
};

export const Soloed: Story = {
  parameters: { episode: { state: { soloTracks: { [TOMAS]: true } } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Solo Tomas" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(header(canvas, "Mira")).toHaveAccessibleDescription(
      "Silent while another track is soloed",
    );
    await expect(
      canvas.getByRole("button", { name: "Solo on · Clear solo" }),
    ).toBeVisible();
  },
};

export const Rebuilding: Story = {
  parameters: {
    episode: { project: withTracks({ [TOMAS]: { stem_is_fresh: false } }) },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(header(canvas, "Tomas")).toHaveAccessibleDescription(
      "Rebuilding. Stem out of date",
    );
    await expect(header(canvas, "Mira")).not.toHaveAccessibleDescription();
  },
};

export const Playing: Story = {
  beforeEach: () => {
    const unbind = bindPlaybackMeterSource({
      read: (id) => (id === MIRA ? [0.5] : [0.05]),
    });
    useDawStore.setState({ isPlaying: true, sourcePreview: null });
    return () => {
      useDawStore.setState({ isPlaying: false });
      unbind();
    };
  },
  play: async ({ canvasElement }) => {
    const mira = canvasElement.querySelectorAll<HTMLElement>(".sys-track")[0];
    await waitFor(() =>
      expect(
        Number(mira.style.getPropertyValue("--sys-track-level")),
      ).toBeGreaterThan(0.5),
    );
  },
};

export const Clipped: Story = {
  beforeEach: () => {
    const unbind = bindPlaybackMeterSource({ read: () => [1] });
    useDawStore.setState({ isPlaying: true, sourcePreview: null });
    return () => {
      useDawStore.setState({ isPlaying: false });
      unbind();
    };
  },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(header(within(canvasElement), "Mira")).toHaveAccessibleDescription(
        /Clipped in playback/,
      ),
    );
  },
};

export const Reordering: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    header(canvas, "Mira").focus();
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await expect(useDawStore.getState().selection).toEqual({
      kind: "track",
      trackId: MIRA,
    });
  },
};

export const Loading: Story = {
  parameters: { episode: { state: { project: null } } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("group", { name: "Tracks" }),
    ).toHaveAttribute("aria-busy", "true");
  },
};
