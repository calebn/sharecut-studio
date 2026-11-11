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
import { clipRow, editBoundaries } from "../../test/fixtures";
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

const THIRD_SEC = EPISODE_DURATION_SEC / 3;
const joinedClips = [
  clipRow({
    id: "clip-mira-a",
    track_id: MIRA,
    source_end: THIRD_SEC,
    timeline_end: THIRD_SEC,
    source_duration_sec: EPISODE_DURATION_SEC,
    fade_out_ms: 80,
    recording_key: "mira-voice-take-1",
  }),
  clipRow({
    id: "clip-mira-b",
    track_id: MIRA,
    source_start: THIRD_SEC,
    source_end: 2 * THIRD_SEC,
    timeline_start: THIRD_SEC,
    timeline_end: 2 * THIRD_SEC,
    source_duration_sec: EPISODE_DURATION_SEC,
    fade_in_ms: 120,
    fade_out_ms: 60,
    join_left_clip_id: "clip-mira-a",
    recording_key: "mira-voice-take-1",
  }),
  clipRow({
    id: "clip-mira-c",
    track_id: MIRA,
    source_start: 2 * THIRD_SEC,
    source_end: EPISODE_DURATION_SEC,
    timeline_start: 2 * THIRD_SEC,
    timeline_end: EPISODE_DURATION_SEC,
    source_duration_sec: EPISODE_DURATION_SEC,
    fade_in_ms: 60,
    join_left_clip_id: "clip-mira-b",
    recording_key: "mira-voice-take-1",
  }),
];
const joined = episode();
joined.clips = {
  tracks: { ...joined.clips.tracks, [MIRA]: joinedClips },
  clip_count: joinedClips.length + 1,
};
joined.edit_boundaries = editBoundaries(joinedClips);
const joinedSelection: Selection = {
  kind: "clip",
  id: "clip-mira-b",
  trackId: MIRA,
};

export const ClipJoins: Story = {
  render: () => <ClipCard selection={joinedSelection} />,
  parameters: {
    episode: { project: joined, role: "editor", selection: joinedSelection },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const start = await canvas.findByRole("spinbutton", {
      name: "Start join length",
    });
    await expect(start).toHaveAttribute("aria-valuenow", "120");
    await expect(start).toHaveAttribute("aria-valuetext", "120 ms");
    await expect(
      canvas.getByRole("spinbutton", { name: "End join length" }),
    ).toHaveAttribute("aria-valuenow", "60");
    await expect(
      within(canvas.getByRole("group", { name: "End join" })).getByRole(
        "button",
        { name: "Fade" },
      ),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.getByRole("spinbutton", { name: "Start join offset" }),
    ).toBeVisible();
  },
};

export const ClipJoinsPhone: Story = {
  render: () => <ClipCard phone selection={joinedSelection} />,
  globals: { viewport: { value: "mobile360", isRotated: false } },
  parameters: {
    episode: { project: joined, role: "editor", selection: joinedSelection },
  },
};

export const ClipJoinsReadOnly: Story = {
  render: () => <ClipCard selection={joinedSelection} />,
  parameters: {
    episode: { project: joined, role: "viewer", selection: joinedSelection },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("spinbutton", { name: "Start join offset" }),
    ).toHaveAttribute("aria-readonly", "true");
    await expect(
      canvas.queryByRole("group", { name: "Start join" }),
    ).toBeNull();
  },
};

const multiSelection: Selection = {
  kind: "clip",
  id: "clip-mira-a",
  trackId: MIRA,
  ids: ["clip-mira-a", "clip-mira-b"],
};

export const MultiClip: Story = {
  render: () => <ClipCard selection={multiSelection} />,
  parameters: {
    episode: { project: joined, role: "editor", selection: multiSelection },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("spinbutton", { name: "Fade in" }),
    ).toHaveAttribute("aria-valuetext", "Mixed");
    await expect(
      canvas.queryByRole("spinbutton", { name: "Start" }),
    ).toBeNull();
  },
};

const gainedClips = joinedClips.map((c) =>
  c.id === "clip-mira-a" ? { ...c, gain_db: -6 } : c,
);
const gained = episode();
gained.clips = {
  tracks: { ...gained.clips.tracks, [MIRA]: gainedClips },
  clip_count: gainedClips.length + 1,
};
gained.edit_boundaries = editBoundaries(gainedClips);
const gainedSelection: Selection = {
  kind: "clip",
  id: "clip-mira-a",
  trackId: MIRA,
};

export const Gain: Story = {
  render: () => <ClipCard selection={gainedSelection} />,
  parameters: {
    episode: { project: gained, role: "editor", selection: gainedSelection },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const gain = await canvas.findByRole("spinbutton", { name: "Gain" });
    await expect(gain).toHaveAttribute("aria-valuenow", "-6");
    await expect(gain).toHaveAttribute("aria-valuemin", "-60");
    await expect(gain).toHaveAttribute("aria-valuemax", "12");
  },
};

export const GainReadOnly: Story = {
  render: () => <ClipCard selection={gainedSelection} />,
  parameters: {
    episode: { project: gained, role: "viewer", selection: gainedSelection },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("spinbutton", { name: "Gain" }),
    ).toHaveAttribute("aria-readonly", "true");
  },
};

export const GainMixed: Story = {
  render: () => <ClipCard selection={multiSelection} />,
  parameters: {
    episode: { project: gained, role: "editor", selection: multiSelection },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("spinbutton", { name: "Gain" }),
    ).toHaveAttribute("aria-valuetext", "Mixed");
  },
};

function withClips(clips: typeof joinedClips) {
  const project = episode();
  project.clips = {
    tracks: { ...project.clips.tracks, [MIRA]: clips },
    clip_count: clips.length + 1,
  };
  project.edit_boundaries = editBoundaries(clips);
  return project;
}
const curvedClips = joinedClips.map((c) =>
  c.id === "clip-mira-a"
    ? {
        ...c,
        fade_in_ms: 80,
        fade_in_curve: "s" as const,
        fade_out_curve: "equal_power" as const,
      }
    : c,
);
const curved = withClips(curvedClips);
const curvedSelection: Selection = {
  kind: "clip",
  id: "clip-mira-a",
  trackId: MIRA,
};
const shape = (canvas: ReturnType<typeof within>, name: string) =>
  within(canvas.getByRole("group", { name }));

export const FadeCurve: Story = {
  render: () => <ClipCard selection={curvedSelection} />,
  parameters: {
    episode: { project: curved, role: "editor", selection: curvedSelection },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("group", { name: "Fade in shape" });
    await expect(
      shape(canvas, "Fade in shape").getByRole("button", { name: "S" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      shape(canvas, "Fade out shape").getByRole("button", {
        name: "Equal power",
      }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};

export const FadeCurvePhone: Story = {
  render: () => <ClipCard phone selection={curvedSelection} />,
  globals: { viewport: { value: "mobile360", isRotated: false } },
  parameters: {
    episode: { project: curved, role: "editor", selection: curvedSelection },
  },
};

export const FadeCurveMixed: Story = {
  render: () => <ClipCard selection={multiSelection} />,
  parameters: {
    episode: { project: curved, role: "editor", selection: multiSelection },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const group = await canvas.findByRole("group", {
      name: "Fade in shape, Mixed",
    });
    await expect(
      within(group).queryByRole("button", { pressed: true }),
    ).toBeNull();
  },
};

const cutClips = curvedClips.map((c) =>
  c.id === "clip-mira-b" ? { ...c, join_in_mode: "cut" } : c,
);
const cutJoin = withClips(cutClips);

export const FadeCurveAtCut: Story = {
  render: () => <ClipCard selection={joinedSelection} />,
  parameters: {
    episode: { project: cutJoin, role: "editor", selection: joinedSelection },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("group", { name: "Fade in shape" });
    await expect(
      shape(canvas, "Fade in shape").getByRole("button", { name: "Linear" }),
    ).toBeDisabled();
    await expect(
      shape(canvas, "Fade out shape").getByRole("button", { name: "Linear" }),
    ).toBeEnabled();
  },
};

const blendedClips = curvedClips.map((c) =>
  c.id === "clip-mira-b"
    ? {
        ...c,
        join_in_mode: "crossfade",
        join_crossfade_ms: 100,
        join_borrow_sec: 0.05,
      }
    : c,
);
const blended = withClips(blendedClips);

export const FadeCurveBlended: Story = {
  render: () => <ClipCard selection={joinedSelection} />,
  parameters: {
    episode: { project: blended, role: "editor", selection: joinedSelection },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("group", { name: "Fade in shape" });
    await expect(
      shape(canvas, "Fade in shape").getByRole("button", { name: "Linear" }),
    ).toBeDisabled();
  },
};
