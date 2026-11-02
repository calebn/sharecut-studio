import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { episode, MIRA, selections, TOMAS } from "../../test/episodeFixture";
import {
  enlargedLandscapeSheet,
  inspectorSheetStoryDecorator,
} from "../../test/inspectorSheetDecorator";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import { ClipInspector } from "./ClipInspector";

const project = episode();
const clip = project.clips.tracks[MIRA][0];

const meta: Meta<typeof ClipInspector> = {
  title: "Templates/Editor · Inspector · Clip",
  component: ClipInspector,
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  render: () => <ClipInspector clip={clip} />,
  parameters: {
    layout: "fullscreen",
    episode: { project, role: "editor", selection: selections.clip },
  },
};
export default meta;
type Story = StoryObj<typeof ClipInspector>;
export const EnlargedTextShortLandscape: Story = {
  ...enlargedLandscapeSheet,
  decorators: [inspectorSheetStoryDecorator],
};

export const PointerPlacement: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Move clip" }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Later 10 ms" }));
    await userEvent.selectOptions(
      canvas.getByRole("combobox", { name: "Target track" }),
      TOMAS,
    );
  },
};
export const PlacementInputError: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Move clip" }),
    );
    await userEvent.clear(canvas.getByLabelText("Timeline start (seconds)"));
  },
};
const timedClip = {
  ...clip,
  timeline_end: clip.timeline_end + 0.12,
  timing_steps: 2,
  timing_summary: "2 corrections, largest 120 ms",
  timing: {
    steps: [
      { at: clip.source_start + 1, delta_sec: 0.12 },
      { at: clip.source_start + 2, delta_sec: -0.05 },
    ],
    method: "bleed_lag",
    micro_fade_ms: 10,
  },
};
const timedProject = {
  ...project,
  clips: {
    ...project.clips,
    tracks: {
      ...project.clips.tracks,
      [MIRA]: [timedClip, ...project.clips.tracks[MIRA].slice(1)],
    },
  },
};
export const TimedClip: Story = {
  render: () => <ClipInspector clip={timedClip} />,
  parameters: {
    episode: {
      project: timedProject,
      role: "editor",
      selection: selections.clip,
    },
  },
};
export const PlacementViewer: Story = {
  parameters: {
    episode: { project, role: "viewer", selection: selections.clip },
  },
};
