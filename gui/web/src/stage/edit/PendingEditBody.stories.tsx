import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { InspectorSheet } from "../../system/InspectorSheet";
import { AnchorMark, Framed } from "../../system/inspectorSheetFixtures";
import { episode, MIRA, selections } from "../../test/episodeFixture";
import { sampleComment } from "../../test/fixtures";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import { usePendingSections } from "./pendingSections";

/** The live pending body read from the hydrated episode, so its role gating is the real one. */
function PendingCard() {
  const sections = usePendingSections(selections.pendingEdit, true) ?? [];
  return (
    <Framed>
      {(bounds) => {
        const anchor = {
          x: Math.round(bounds.width * 0.4),
          y: 72,
          width: 160,
          height: 40,
        };
        return (
          <>
            <AnchorMark anchor={anchor} />
            <InspectorSheet
              form="card"
              icon="scissors"
              name="Suggestion"
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
  title: "Stages/Edit/PendingInspector",
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  render: () => <PendingCard />,
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The live pending edit body (`PendingEditBody`) in an Inspector card, read from the hydrated episode: the host sees a compact Decision card (kind, reason, five-dot confidence, Start and End) and the Ask thread with Resolve; a Commenter link asks and replies but cannot resolve or tick action items.",
      },
    },
  },
};

export default meta;
type Story = StoryObj;

const [seededEdit] = episode().pending_edits;

export const SuggestionLowConfidence: Story = {
  parameters: {
    episode: {
      project: episode({
        pending_edits: seededEdit
          ? [{ ...seededEdit, cut_confidence: 0.31 }]
          : [],
      }),
      selection: selections.pendingEdit,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("img", { name: "Confidence 2 of 5" }),
    ).toBeVisible();
    await expect(
      await canvas.findByRole("spinbutton", { name: "Source start" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("region", { name: "Ask about this edit" }),
    ).toBeVisible();
  },
};

export const SuggestionGuest: Story = {
  parameters: {
    episode: { role: "commenter", selection: selections.pendingEdit },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const ask = await canvas.findByRole("region", {
      name: "Ask about this edit",
    });
    await expect(
      within(ask).getByRole("textbox", { name: "Your name" }),
    ).toBeVisible();
    await expect(
      within(ask).getByRole("textbox", { name: "Your question" }),
    ).toBeVisible();
  },
};

export const CommentGuest: Story = {
  parameters: {
    episode: {
      project: episode({
        comments: [
          sampleComment({
            id: "ask-1",
            author: "Ines",
            body: "Why shorten this pause?",
            edit_decision_id: seededEdit?.id,
            timeline_start: seededEdit?.timeline_start ?? 0,
            timeline_end: seededEdit?.timeline_end ?? null,
            track_ids: [MIRA],
            replies: [
              {
                id: "ask-1-reply",
                author: "Mira",
                body: "It reads as a beat, so I left it.",
                created_at: "2026-01-01T10:00:00Z",
              },
            ],
          }),
        ],
      }),
      role: "commenter",
      selection: selections.pendingEdit,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const ask = await canvas.findByRole("region", {
      name: "Ask about this edit",
    });
    await expect(
      within(ask).getByText("Why shorten this pause?"),
    ).toBeVisible();
    await expect(
      within(ask).getByRole("textbox", { name: "Reply to Ines" }),
    ).toBeVisible();
    await expect(
      within(ask).queryByRole("button", { name: "Resolve" }),
    ).toBeNull();
  },
};
