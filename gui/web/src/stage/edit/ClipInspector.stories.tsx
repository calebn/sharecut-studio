import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import {
  type InspectorSection,
  InspectorSheet,
} from "../../system/InspectorSheet";
import { AnchorMark, Framed } from "../../system/inspectorSheetFixtures";
import { episode, selections } from "../../test/episodeFixture";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import { useClipSections } from "./clipSections";

function ClipCard({ phone = false }: { phone?: boolean }) {
  const sections: readonly InspectorSection[] =
    useClipSections(selections.clip) ?? [];
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
      canvas.getByRole("button", { name: "Move clip" }),
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
