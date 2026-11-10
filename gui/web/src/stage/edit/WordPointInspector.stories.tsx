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
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import type { Selection } from "../../types/project";
import { useEnvelopePointSections } from "./envelopePointSections";
import { inspectorHeading } from "./inspectorHeading";
import { useSelectionSections } from "./selectionSections";

const point: Selection = {
  kind: "envelopePoint",
  trackId: MIRA,
  pointId: "point-2",
};

function PointCard({
  selection,
  phone = false,
}: {
  selection: Selection;
  phone?: boolean;
}) {
  const project = useDawStore((s) => s.project);
  const heading = inspectorHeading(selection, project);
  const rebuilt = useSelectionSections(selection);
  const envelope = useEnvelopePointSections(selection);
  const sections: readonly InspectorSection[] = rebuilt ?? envelope ?? [];
  const [detent, setDetent] = useState<"half" | "full" | "dock">("half");
  return (
    <Framed>
      {(bounds) => {
        const anchor = { x: bounds.width * 0.4, y: 72, width: 160, height: 40 };
        return phone ? (
          <InspectorSheet
            form="phone"
            {...heading}
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
              {...heading}
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

const wordCard = (phone = false) => (
  <PointCard selection={selections.word} phone={phone} />
);

const pointCard = (phone = false) => (
  <PointCard selection={point} phone={phone} />
);

const meta: Meta = {
  title: "Stages/Edit/WordPointInspector",
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  render: () => wordCard(),
  parameters: {
    ...viewportStoryParameters,
    episode: {
      project: episode(),
      role: "host",
      selection: selections.word,
    },
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The live one-word and volume-point bodies in an Inspector card, read from the hydrated episode. A word lists its Text, a five-dot Confidence meter and Suppress; Ignore and Restore are the Action bar's Mute row, and there is no seek footer. A volume point has Time and Level Scrub fields and Remove.",
      },
    },
  },
};

export default meta;
type Story = StoryObj;

export const Word: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("img", { name: /^Confidence \d of 5$/ }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Suppress" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Ignore" })).toBeNull();
  },
};

export const WordLowConfidence: Story = {
  parameters: {
    episode: {
      project: episode(),
      role: "host",
      selection: selections.lowConfidenceWord,
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("img", {
        name: /^Confidence [0-2] of 5$/,
      }),
    ).toBeVisible();
  },
};

export const WordPhone: Story = {
  render: () => wordCard(true),
  globals: { viewport: { value: "mobile360", isRotated: false } },
};

export const EnvelopePoint: Story = {
  render: () => pointCard(),
  parameters: {
    episode: { project: episode(), role: "host", selection: point },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("spinbutton", { name: "Time" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("spinbutton", { name: "Level" }),
    ).toBeVisible();
  },
};

export const EnvelopePointPhone: Story = {
  render: () => pointCard(true),
  parameters: {
    episode: { project: episode(), role: "host", selection: point },
  },
  globals: { viewport: { value: "mobile360", isRotated: false } },
};
