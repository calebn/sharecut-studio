import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import type { PresencePerson, PresenceSelection } from "../../system/Presence";
import { Timeline } from "./timelineDemo";

const REMOTE: readonly PresencePerson[] = [
  { id: "maya", name: "Maya Okafor", colorIndex: 0, playhead: 12.5 },
  { id: "anneke", name: "Anneke de Vries", colorIndex: 1, playhead: 15 },
];

const meta: Meta<typeof Timeline> = {
  title: "Stages/Edit/Timeline",
  component: Timeline,
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The Edit timeline stack from its parts (design-system elements 15 and 15a, spec-edit CMP-TIMELINE): a header column of System/TrackHeader beside one time column of System/Ruler, System/MarkerLane and three System/Lane of System/Clip, with System/Presence laid over all of it. Every part takes the same window, so a time lands at the same x in each: the remote playheads line up with the ruler's own to half a pixel, and a remote selection sits in its lane at that lane's height. Lanes are 72, 104 and 72 px here. Deep zoom is 120 px per second, and on a phone the playhead stays at the middle of the time column while the content scrolls under it. This is the integration check for the parts, not a screen: nothing here is wired.\n\n**Motion.** None.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Timeline>;

const SELECTIONS: readonly PresenceSelection[] = [
  {
    id: "anneke-sel",
    personId: "anneke",
    laneId: "anneke",
    start: 6.5,
    end: 16.5,
    colorIndex: 1,
  },
];

export const ThreeTracks: Story = {
  args: {
    playhead: 3,
    people: REMOTE,
    selections: SELECTIONS,
    selectedClip: "Maya, take 2",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("group", { name: "Track Maya Okafor" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("slider", { name: "Timeline position" }),
    ).toBeVisible();
    await expect(
      canvasElement.querySelectorAll(".sys-presence-line"),
    ).toHaveLength(2);
  },
};

export const DeepZoom: Story = {
  args: {
    pxPerSecond: 120,
    start: 8,
    playhead: 8.4,
    people: [
      { id: "maya", name: "Maya Okafor", colorIndex: 0, playhead: 8.5 },
      { id: "anneke", name: "Anneke de Vries", colorIndex: 1, playhead: 8.9 },
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelectorAll(".sys-presence-line").length,
    ).toBeGreaterThan(0);
  },
};

export const PhoneFixedPlayhead: Story = {
  args: {
    form: "phone",
    fixedPlayhead: true,
    playhead: 12,
    people: [{ id: "maya", name: "Maya Okafor", colorIndex: 0, playhead: 13 }],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("slider", { name: "Timeline position" }),
    ).toBeVisible();
  },
};
