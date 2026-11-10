import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import {
  type InspectorSection,
  InspectorSheet,
} from "../../system/InspectorSheet";
import type { SystemIconName } from "../../system/icons";
import { AnchorMark, Framed } from "../../system/inspectorSheetFixtures";
import { episode, selections, TOMAS } from "../../test/episodeFixture";
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

const socialCard = (
  phone = false,
  selection: Selection = selections.social,
) => (
  <MarkerCard
    selection={selection}
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
          "The live chapter and social clip bodies (`useChapterSections`, `useSocialSections`) in an Inspector card, read from the hydrated episode: a chapter's Title is an inline field saved on Enter or blur (Escape puts it back), Time is a Scrub field bounded to the episode, a social clip's Title is a host-only inline field, Start and End are Scrub fields that save once per commit, Quality is a five-dot meter shown when the score is above 0, and a chapter and a social clip are removed from the Action bar. A Viewer link sees the same values read-only.",
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
    const title = canvas.getByRole("textbox", { name: "Title" });
    await userEvent.clear(title);
    await userEvent.type(title, "Interview");
    await userEvent.keyboard("{Escape}");
    await expect(title).toHaveValue("The harbor depot");
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
      await canvas.findByRole("textbox", { name: "Title" }),
    ).toHaveValue("A loaf tells you when it is ready");
    await expect(
      canvas.getByRole("spinbutton", { name: "Start" }),
    ).toBeVisible();
    await expect(canvas.getByRole("spinbutton", { name: "End" })).toBeVisible();
    await expect(
      canvas.getByRole("img", { name: "Quality 4 of 5" }),
    ).toBeVisible();
    await expect(canvas.queryByText("Score")).toBeNull();
    await expect(
      canvas.queryByRole("button", { name: "Seek to start" }),
    ).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Delete" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Apply" })).toBeNull();
  },
};

const MANUAL_CLIP = "manual_ab12cd34ef";

export const SocialClipManual: Story = {
  render: () => socialCard(false, { kind: "social", id: MANUAL_CLIP }),
  parameters: {
    episode: {
      project: episode({
        social_clips: [
          {
            id: MANUAL_CLIP,
            track_id: TOMAS,
            start: 60,
            end: 75,
            score: 0,
            title_suggestion: null,
            approved: false,
            review_required: true,
          },
        ],
      }),
      role: "host",
      selection: { kind: "social", id: MANUAL_CLIP },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = await canvas.findByRole("textbox", { name: "Title" });
    await expect(title).toHaveValue("");
    await expect(title).toHaveAttribute("placeholder", "Untitled clip");
    await expect(canvas.queryByRole("img", { name: /Quality/ })).toBeNull();
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
    await expect(
      canvas.getByText("A loaf tells you when it is ready"),
    ).toBeVisible();
    await expect(canvas.queryByRole("textbox", { name: "Title" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Delete" })).toBeNull();
  },
};
