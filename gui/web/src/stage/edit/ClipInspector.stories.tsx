import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import {
  type InspectorSection,
  InspectorSheet,
} from "../../system/InspectorSheet";
import { AnchorMark, Framed } from "../../system/inspectorSheetFixtures";
import {
  EPISODE_DURATION_SEC,
  episode,
  MIRA,
  selections,
} from "../../test/episodeFixture";
import { clipRow } from "../../test/fixtures";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import type { Selection } from "../../types/project";
import { useClipSections } from "./clipSections";

function ClipCard({
  phone = false,
  selection = selections.clip,
}: {
  phone?: boolean;
  selection?: Selection;
}) {
  const sections: readonly InspectorSection[] =
    useClipSections(selection) ?? [];
  const [detent, setDetent] = useState<"half" | "full" | "dock">("half");
  return (
    <Framed>
      {(bounds) => {
        const anchor = { x: bounds.width * 0.4, y: 72, width: 160, height: 40 };
        return phone ? (
          <InspectorSheet
            form="phone"
            icon="sliders-horizontal"
            name="Mira clip"
            sections={sections}
            detent={detent}
            onDetentChange={setDetent}
            onDismiss={fn()}
            onClose={fn()}
          />
        ) : (
          <>
            <AnchorMark anchor={anchor} />
            <InspectorSheet
              form="card"
              icon="sliders-horizontal"
              name="Mira clip"
              sections={sections}
              anchor={anchor}
              bounds={bounds}
              onClose={fn()}
            />
          </>
        );
      }}
    </Framed>
  );
}

const meta: Meta = {
  title: "Stages/Edit/ClipInspector",
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  render: () => <ClipCard />,
  parameters: {
    ...viewportStoryParameters,
    episode: { project: episode(), role: "editor", selection: selections.clip },
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The live clip body (`useClipSections`) in an Inspector card, read from the hydrated episode: source edges and fades are Scrub fields; a Viewer link sees the same values read-only.",
      },
    },
  },
};

export default meta;
type Story = StoryObj;

export const Clip: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("spinbutton", { name: "Fade in" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("spinbutton", { name: "Start" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("group", { name: "Move to track" }),
    ).toBeVisible();
  },
};

export const ClipPhone: Story = {
  render: () => <ClipCard phone />,
  globals: { viewport: { value: "mobile360", isRotated: false } },
};

export const ClipReadOnly: Story = {
  parameters: {
    episode: { project: episode(), role: "viewer", selection: selections.clip },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("spinbutton", { name: "Source start" }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "Ripple delete" }),
    ).toBeNull();
  },
};

const HALF_SEC = EPISODE_DURATION_SEC / 2;
const joinedClips = [
  clipRow({
    id: "clip-mira-a",
    track_id: MIRA,
    source_end: HALF_SEC,
    timeline_end: HALF_SEC,
    source_duration_sec: EPISODE_DURATION_SEC,
    fade_out_ms: 80,
    recording_key: "mira-voice-take-1",
  }),
  clipRow({
    id: "clip-mira-b",
    track_id: MIRA,
    source_start: HALF_SEC,
    source_end: EPISODE_DURATION_SEC,
    timeline_start: HALF_SEC,
    timeline_end: EPISODE_DURATION_SEC,
    source_duration_sec: EPISODE_DURATION_SEC,
    fade_in_ms: 120,
    join_left_clip_id: "clip-mira-a",
    recording_key: "mira-voice-take-1",
  }),
];
const joined = episode();
joined.clips = {
  tracks: { ...joined.clips.tracks, [MIRA]: joinedClips },
  clip_count: joinedClips.length + 1,
};
const joinedSelection: Selection = {
  kind: "clip",
  id: "clip-mira-b",
  trackId: MIRA,
};

export const ClipTransition: Story = {
  render: () => <ClipCard selection={joinedSelection} />,
  parameters: {
    episode: { project: joined, role: "editor", selection: joinedSelection },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const length = await canvas.findByRole("spinbutton", {
      name: "Transition length",
    });
    await expect(length).toHaveAttribute("aria-valuenow", "120");
    await expect(length).toHaveAttribute("aria-valuetext", "120 ms");
  },
};

export const ClipTransitionPhone: Story = {
  render: () => <ClipCard phone selection={joinedSelection} />,
  globals: { viewport: { value: "mobile360", isRotated: false } },
  parameters: {
    episode: { project: joined, role: "editor", selection: joinedSelection },
  },
};
