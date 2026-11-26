import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { ENVELOPE_POINTS } from "../../system/laneFixtures";
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
          "The Edit timeline stack from its parts (design-system elements 15 and 15a, spec-edit CMP-TIMELINE): a header column of System/TrackHeader beside one time column of System/Ruler, System/MarkerLane and three System/Lane of System/Clip, with System/Presence laid over all of it, and, in WithEnvelope, System/Envelope over Maya's lane. Every part takes the same window, so a time lands at the same x in each: the remote playheads line up with the ruler's own to half a pixel, and a remote selection sits in its lane at that lane's height. Lanes are 72, 104 and 72 px here. Maya's playhead is on the ruler's own, in ThreeTracks at a whole pixel and in DeepZoom (120 px per second) at a fractional one, and on a phone the playhead stays at the middle of the time column while the content scrolls under it. This is the integration check for the parts, not a screen: nothing here is wired, except that a `+N` flag opens its menu of people (Cluster, ClusterMenuOpen) and a link that cannot open where they are draws plain marks (GuestCluster).\n\n**Motion.** None.",
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
    playhead: 12.5,
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
  },
};

export const WithEnvelope: Story = {
  args: {
    playhead: 12.5,
    selectedClip: "Maya, take 2",
    envelope: ENVELOPE_POINTS,
    envelopeSelected: "env-3",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("group", { name: "Volume envelope, Maya Okafor" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("slider", { name: "Envelope point 1" }),
    ).toBeVisible();
  },
};

export const DeepZoom: Story = {
  args: {
    pxPerSecond: 120,
    start: 8,
    playhead: 8.5037,
    people: [
      { id: "maya", name: "Maya Okafor", colorIndex: 0, playhead: 8.5037 },
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
    people: [
      { id: "maya", name: "Maya Okafor", colorIndex: 0, playhead: 13 },
      { id: "anneke", name: "Anneke de Vries", colorIndex: 1, playhead: 17.5 },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("slider", { name: "Timeline position" }),
    ).toBeVisible();
  },
};

const CLUSTER_ARGS = {
  playhead: 6.5,
  people: [
    { id: "maya", name: "Maya Okafor", colorIndex: 0, playhead: 6 },
    { id: "anneke", name: "Anneke de Vries", colorIndex: 1, playhead: 6.4 },
    { id: "leo", name: "Leo Brandt", colorIndex: 2, playhead: 6.7 },
  ],
};

export const Cluster: Story = {
  args: CLUSTER_ARGS,
  play: async ({ canvasElement }) => {
    const group = canvasElement.querySelector<HTMLElement>(
      "button.sys-presence-hit",
    );
    await expect(group).toHaveTextContent("+3");
  },
};

export const ClusterMenuOpen: Story = {
  args: CLUSTER_ARGS,
  play: async ({ canvasElement }) => {
    const group = canvasElement.querySelector<HTMLElement>(
      "button.sys-presence-hit",
    );
    await expect(group).toHaveTextContent("+3");
    await userEvent.click(group as HTMLElement);
    const menu = await within(canvasElement.ownerDocument.body).findByRole(
      "menu",
      { name: "3 people near 0:06" },
    );
    await expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);
  },
};

export const GuestCluster: Story = {
  args: {
    playhead: 6.5,
    canGoTo: false,
    people: [
      { id: "maya", name: "Maya Okafor", colorIndex: 0, playhead: 6 },
      { id: "anneke", name: "Anneke de Vries", colorIndex: 1, playhead: 6.4 },
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelectorAll(".sys-presence-flag"),
    ).toHaveLength(1);
    await expect(
      canvasElement.querySelector(".sys-presence button"),
    ).toBeNull();
  },
};
