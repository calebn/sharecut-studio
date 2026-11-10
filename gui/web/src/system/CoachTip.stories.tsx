import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { clipRow } from "../test/fixtures";
import { ClipBlockView } from "../timeline/ClipBlockView";
import { clipBlockGeometry } from "../timeline/clipBlockGeometry";
import { laneColor } from "../timeline/laneColors";
import { timelineLaneStoryDecorator } from "../timeline/timelineLaneStoryDecorator";
import { Button } from "../ui";
import { COACH_TIPS } from "../utils/coachTip";
import { CoachTip } from "./CoachTip";
import { CoachTipBubble } from "./CoachTipBubble";
import { VerbButton } from "./VerbButton";

const meta: Meta<typeof CoachTip> = {
  title: "System/CoachTip",
  component: CoachTip,
  tags: ["autodocs"],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          'A one-line hint anchored to an element, shown once at the moment of first need and dismissed by any action. The caller owns "shown once"; the story keeps no storage.\n\n**Motion.** Fades in with `--motion-state` and out with `--motion-hover` in the animation pass; not implemented in this slice.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof CoachTip>;

function Demo({ placement }: { placement: "below" | "above" }) {
  const [shown, setShown] = useState(true);
  return (
    <div
      style={{
        paddingBlock:
          placement === "above"
            ? "calc(var(--space-8) + var(--space-8))"
            : "var(--space-8)",
        paddingInline: "var(--space-5)",
        display: "flex",
        justifyContent: "flex-start",
      }}
    >
      <CoachTip
        text="Solo is just for your ears"
        placement={placement}
        shown={shown}
        onDismiss={() => setShown(false)}
      >
        <Button>Solo</Button>
      </CoachTip>
    </div>
  );
}

export const Below: Story = {
  render: () => <Demo placement="below" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("note")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Dismiss hint" }));
    await expect(canvas.queryByRole("note")).toBeNull();
    // The close button unmounted with the tip; focus goes back to the anchor.
    await expect(canvas.getByRole("button", { name: "Solo" })).toHaveFocus();
  },
};

export const Above: Story = { render: () => <Demo placement="above" /> };

export const DismissedByAction: Story = {
  render: () => <Demo placement="below" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("note")).toHaveTextContent(
      "Solo is just for your ears",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Solo" }));
    await expect(canvas.queryByRole("note")).toBeNull();
  },
};

function UndoDemo() {
  const [shown, setShown] = useState(true);
  return (
    <div
      style={{
        position: "relative",
        paddingBlock: "var(--space-5) calc(var(--space-8) * 3)",
        paddingInlineStart: "40%",
      }}
    >
      <CoachTip
        edge
        align="end"
        placement="below"
        text={COACH_TIPS.undo}
        shown={shown}
        onDismiss={() => setShown(false)}
      >
        <VerbButton verb="undo" />
      </CoachTip>
    </div>
  );
}

function RangeDemo() {
  const [shown, setShown] = useState(true);
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        paddingBlock: "calc(var(--space-8) + var(--space-8)) var(--space-5)",
        paddingInline: "var(--space-5)",
      }}
    >
      <CoachTip
        align="end"
        placement="above"
        text={COACH_TIPS.rangeToggle}
        shown={shown}
        onDismiss={() => setShown(false)}
      >
        <Button aria-label="Select range">Range</Button>
      </CoachTip>
    </div>
  );
}

const checkNote = async (
  canvasElement: HTMLElement,
  text: string,
): Promise<void> => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("note")).toHaveTextContent(text);
  await expect(
    canvas.getByRole("button", { name: "Dismiss hint" }),
  ).toBeVisible();
};

/** The tip at the header's inline end, below the bar under Undo, held inside the header's width. */
export const UndoHint: Story = {
  render: () => <UndoDemo />,
  play: ({ canvasElement }) => checkNote(canvasElement, COACH_TIPS.undo),
};

/** The tip beside the end grip, in a positioned box where the grips live. */
export const SelectionHandlesHint: Story = {
  render: () => (
    <div
      style={{
        position: "relative",
        blockSize: "10rem",
        marginInline: "var(--space-5)",
        marginBlock: "var(--space-5)",
      }}
    >
      <CoachTipBubble
        className="sys-coach-tip--at"
        text={COACH_TIPS.selectionHandles}
        onClose={() => {}}
        style={{
          insetInlineStart: "max(0px, min(11rem, calc(100% - 15rem)))",
          insetBlockStart: "calc(2rem + var(--space-6))",
        }}
      />
    </div>
  ),
  play: ({ canvasElement }) =>
    checkNote(canvasElement, COACH_TIPS.selectionHandles),
};

/** The tip over the range toggle, which sits in the corner at the foot of the lanes. */
export const RangeToggleHint: Story = {
  render: () => <RangeDemo />,
  play: ({ canvasElement }) => checkNote(canvasElement, COACH_TIPS.rangeToggle),
};

// A non-literal value keeps the ARIA-role lint from reading this speaker role as an ARIA role.
const DIALOGUE = "dialogue";

const trimClip = clipRow({
  id: "story-trim-hint",
  source_start: 0,
  source_end: 7,
  timeline_start: 0,
  timeline_end: 7,
});

export const TrimHint: Story = {
  decorators: [timelineLaneStoryDecorator],
  parameters: { phoneWidth: true, lanePreviewLabel: "Trim hint" },
  render: () => (
    <ClipBlockView
      clip={trimClip}
      role={DIALOGUE}
      zoomPxPerSec={40}
      color={laneColor("dialogue", 0)}
      selected
      geometry={clipBlockGeometry({
        clip: trimClip,
        zoomPxPerSec: 40,
        rollPreview: null,
        trimPreview: null,
        fadePreview: null,
        previewTimelineStart: null,
      })}
      nextClip={null}
      showHandles
      trimHint={{ text: COACH_TIPS.trim, shown: true, onDismiss: () => {} }}
    />
  ),
  play: async ({ canvasElement }) => {
    // The jsdom run has no layout, so the tip finds no spot there; the browser run measures it.
    if (canvasElement.getBoundingClientRect().width === 0) return;
    await checkNote(canvasElement, COACH_TIPS.trim);
    const note = document
      .querySelector(".sys-coach-tip")!
      .getBoundingClientRect();
    const handle = canvasElement
      .querySelector(".trim-handle.in")!
      .getBoundingClientRect();
    const apart =
      note.right <= handle.left ||
      note.left >= handle.right ||
      note.bottom <= handle.top ||
      note.top >= handle.bottom;
    await expect(apart).toBe(true);
  },
};
