import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, within } from "storybook/test";
import { useDawStore } from "../../state/dawStore";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import {
  type InspectorSection,
  InspectorSheet,
} from "../../system/InspectorSheet";
import { AnchorMark, Framed } from "../../system/inspectorSheetFixtures";
import { episode, MIRA, selections } from "../../test/episodeFixture";
import { editBoundaries } from "../../test/fixtures";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import type { ProjectView } from "../../types/project";
import { EditActionBar } from "./EditActionBar";
import { inspectorHeading } from "./inspectorHeading";
import { useSeamSections } from "./seamSections";

function SeamCard({ phone = false }: { phone?: boolean }) {
  const selection = useDawStore((s) => s.selection);
  const project = useDawStore((s) => s.project);
  const sections: readonly InspectorSection[] =
    useSeamSections(selection) ?? [];
  const [detent, setDetent] = useState<"half" | "full" | "dock">("half");
  const heading = inspectorHeading(selection, project);
  return (
    <Framed>
      {(bounds) => {
        const anchor = { x: bounds.width * 0.4, y: 72, width: 160, height: 40 };
        return phone ? (
          <InspectorSheet
            form="phone"
            icon={heading.icon}
            name={heading.name}
            sections={sections}
            detent={detent}
            onDetentChange={setDetent}
            onDismiss={fn()}
            onClose={fn()}
            dock={<EditActionBar form="dock" root={null} inInspector />}
          />
        ) : (
          <>
            <AnchorMark anchor={anchor} />
            <EditActionBar form="dock" root={null} />
            <InspectorSheet
              form="card"
              icon={heading.icon}
              name={heading.name}
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

function withRecords(
  restore: ProjectView["applied_edits"]["records"][number]["restore"],
): ProjectView {
  const base = episode();
  return {
    ...base,
    applied_edits: {
      ...base.applied_edits,
      records: base.applied_edits.records.map((record) => ({
        ...record,
        restore,
      })),
    },
  };
}

function withSplit(): ProjectView {
  const base = episode();
  const [first, second] = base.clips.tracks[MIRA];
  const lane = [first, { ...second, source_start: first.source_end }];
  return {
    ...base,
    clips: { ...base.clips, tracks: { ...base.clips.tracks, [MIRA]: lane } },
    edit_boundaries: editBoundaries(lane),
    applied_edits: { ...base.applied_edits, count: 0, records: [] },
  };
}

function withCrossfade(): ProjectView {
  const base = withRecords({ state: "ready" });
  const lane = base.clips.tracks[MIRA].map((clip, index) =>
    index === 1
      ? {
          ...clip,
          join_in_mode: "crossfade" as const,
          join_crossfade_ms: 120,
          fade_in_ms: 120,
        }
      : { ...clip, fade_out_ms: 120 },
  );
  return {
    ...base,
    clips: { ...base.clips, tracks: { ...base.clips.tracks, [MIRA]: lane } },
  };
}

const meta: Meta = {
  title: "Stages/Edit/Seam",
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  render: () => <SeamCard />,
  parameters: {
    ...viewportStoryParameters,
    episode: {
      project: withRecords({ state: "ready" }),
      role: "editor",
      selection: selections.seam,
    },
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "A selected seam: the Action bar (`EditActionBar`: Hear, Join type, Keep, Comment, Inspect) and the seam sheet (`useSeamSections`: what applied the cut, the Offset and Length scrubs), both read from the hydrated episode.",
      },
    },
  },
};

export default meta;
type Story = StoryObj;

export const CutSeamWithKeep: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Keep" }),
    ).toBeEnabled();
    await expect(
      canvas.getByRole("group", { name: "Join type" }),
    ).toBeVisible();
    await expect(canvas.getAllByText(/Trim the false start/)[0]).toBeVisible();
    await expect(
      canvas.getByRole("spinbutton", { name: "Offset" }),
    ).toHaveAttribute("aria-valuenow", "0");
  },
};

export const Blocked: Story = {
  parameters: {
    episode: {
      project: withRecords({
        state: "blocked",
        code: "overlaps",
        message: "Restore the later cut first",
        blocked_by: ["later-edit"],
      }),
      role: "editor",
      selection: selections.seam,
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", { name: "Keep" }),
    ).toBeDisabled();
  },
};

export const SplitSeam: Story = {
  parameters: {
    episode: {
      project: withSplit(),
      role: "editor",
      selection: selections.seam,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("group", { name: "Join type" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Keep" })).toBeNull();
  },
};

export const CrossfadeInspector: Story = {
  parameters: {
    episode: {
      project: withCrossfade(),
      role: "editor",
      selection: selections.seam,
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("spinbutton", { name: "Length" }),
    ).toHaveAttribute("aria-valuemin", "1");
  },
};

export const Phone: Story = {
  render: () => <SeamCard phone />,
  globals: { viewport: { value: "mobile360", isRotated: false } },
};
