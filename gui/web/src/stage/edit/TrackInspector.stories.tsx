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
import { useTrackSections } from "./trackSections";

function TrackCard({ phone = false }: { phone?: boolean }) {
  const sections: readonly InspectorSection[] =
    useTrackSections(selections.track) ?? [];
  const [detent, setDetent] = useState<"half" | "full" | "dock">("half");
  return (
    <Framed>
      {(bounds) => {
        const anchor = { x: bounds.width * 0.4, y: 72, width: 160, height: 40 };
        return phone ? (
          <InspectorSheet
            form="phone"
            icon="volume-1"
            name="Mira"
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
              icon="volume-1"
              name="Mira"
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
  title: "Stages/Edit/TrackInspector",
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  render: () => <TrackCard />,
  parameters: {
    ...viewportStoryParameters,
    episode: {
      project: episode(),
      role: "editor",
      selection: selections.track,
    },
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The live track body (`useTrackSections`) in an Inspector card, read from the hydrated episode: Level is a Scrub field, Mute, Solo and the effect Bypass rows write as before; a Viewer link sees the same values read-only.",
      },
    },
  },
};

export default meta;
type Story = StoryObj;

export const Track: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("spinbutton", { name: "Level" }),
    ).toBeVisible();
    await expect(canvas.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Mira",
    );
    await expect(canvas.getByRole("combobox", { name: "Role" })).toBeVisible();
  },
};

export const TrackPhone: Story = {
  render: () => <TrackCard phone />,
  globals: { viewport: { value: "mobile360", isRotated: false } },
};

export const TrackReadOnly: Story = {
  parameters: {
    episode: {
      project: episode(),
      role: "viewer",
      selection: selections.track,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("spinbutton", { name: "Level" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("combobox", { name: "Role" })).toBeNull();
    await expect(canvas.queryByRole("textbox", { name: "Name" })).toBeNull();
    await expect(
      canvas.queryByRole("button", { name: "Remove track" }),
    ).toBeNull();
  },
};
