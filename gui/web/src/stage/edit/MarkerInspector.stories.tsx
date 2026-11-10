import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import {
  type InspectorSection,
  InspectorSheet,
} from "../../system/InspectorSheet";
import type { SystemIconName } from "../../system/icons";
import { AnchorMark, Framed } from "../../system/inspectorSheetFixtures";
import { episode, selections } from "../../test/episodeFixture";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import type { Selection } from "../../types/project";
import { useSelectionSections } from "./selectionSections";

function MarkerCard({
  selection,
  icon,
  name,
  phone = false,
}: {
  selection: Selection;
  icon: SystemIconName;
  name: string;
  phone?: boolean;
}) {
  const sections: readonly InspectorSection[] =
    useSelectionSections(selection) ?? [];
  const [detent, setDetent] = useState<"half" | "full" | "dock">("half");
  return (
    <Framed>
      {(bounds) => {
        const anchor = { x: bounds.width * 0.4, y: 72, width: 160, height: 40 };
        return phone ? (
          <InspectorSheet
            form="phone"
            icon={icon}
            name={name}
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
              icon={icon}
              name={name}
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

const chapterCard = (phone = false) => (
  <MarkerCard
    selection={selections.chapter}
    icon="flag"
    name="Chapter"
    phone={phone}
  />
);

const socialCard = (phone = false) => (
  <MarkerCard
    selection={selections.social}
    icon="send"
    name="Social clip"
    phone={phone}
  />
);

const meta: Meta = {
  title: "Stages/Edit/MarkerInspector",
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  render: () => chapterCard(),
  parameters: {
    ...viewportStoryParameters,
    episode: {
      project: episode(),
      role: "host",
      selection: selections.chapter,
    },
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The live chapter and social clip bodies (`useChapterSections`, `useSocialSections`) in an Inspector card, read from the hydrated episode: Title is a text field saved on blur or Enter, Time, Start and End are Scrub fields that save once per commit, and a chapter and a social clip are removed from the Action bar. A Viewer link sees the same values read-only.",
      },
    },
  },
};

export default meta;
type Story = StoryObj;

export const Chapter: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("textbox", { name: "Title" }),
    ).toHaveValue("The harbor depot");
    await expect(
      canvas.getByRole("spinbutton", { name: "Time" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Apply" })).toBeNull();
  },
};

export const ChapterPhone: Story = {
  render: () => chapterCard(true),
  globals: { viewport: { value: "mobile360", isRotated: false } },
};

export const ChapterReadOnly: Story = {
  parameters: {
    episode: {
      project: episode(),
      role: "viewer",
      selection: selections.chapter,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("spinbutton", { name: "Time" }),
    ).toHaveAttribute("aria-readonly", "true");
    await expect(canvas.queryByRole("textbox", { name: "Title" })).toBeNull();
  },
};

export const SocialClip: Story = {
  render: () => socialCard(),
  parameters: {
    episode: {
      project: episode(),
      role: "host",
      selection: selections.social,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("spinbutton", { name: "Start" }),
    ).toBeVisible();
    await expect(canvas.getByRole("spinbutton", { name: "End" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Delete" })).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Apply" })).toBeNull();
  },
};

export const SocialClipPhone: Story = {
  render: () => socialCard(true),
  globals: { viewport: { value: "mobile360", isRotated: false } },
  parameters: {
    episode: {
      project: episode(),
      role: "host",
      selection: selections.social,
    },
  },
};

export const SocialClipReadOnly: Story = {
  render: () => socialCard(),
  parameters: {
    episode: {
      project: episode(),
      role: "viewer",
      selection: selections.social,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("spinbutton", { name: "Start" }),
    ).toHaveAttribute("aria-readonly", "true");
    await expect(canvas.queryByRole("button", { name: "Delete" })).toBeNull();
  },
};
