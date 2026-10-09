import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, fn, waitFor, within } from "storybook/test";
import { capabilityTooltip } from "../capabilities/copy";
import { rollJoinInterval } from "../edit/rollLimits";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { useDawStore } from "../state/dawStore";
import { clipRow } from "../test/fixtures";
import type { EditBoundaryView } from "../types/project";
import { resolveBoundaryPresentation } from "./boundaryPresentation";
import { EditBoundaryMarkView } from "./EditBoundaryMarkView";
import { TRANSCRIPT_EDIT_BOUNDARY_TIP } from "./transcriptModeCopy";

const boundary: EditBoundaryView = {
  id: "eb:left:right",
  track_id: "host",
  left_clip_id: "left",
  right_clip_id: "right",
  timeline_join_sec: 10,
  cutaway_source_start: 20,
  cutaway_source_end: 25,
  has_cutaway: true,
  cutaway_word_ids: [
    {
      track_id: "host",
      source_id: null,
      word_index: 3,
      text: "before",
      start: 20.1,
      end: 20.5,
    },
    {
      track_id: "host",
      source_id: null,
      word_index: 4,
      text: "we",
      start: 20.6,
      end: 20.8,
    },
    {
      track_id: "host",
      source_id: null,
      word_index: 5,
      text: "begin",
      start: 20.9,
      end: 21.2,
    },
  ],
};

const left = clipRow({
  id: "left",
  source_duration_sec: 80,
  source_start: 10,
  source_end: 20,
  timeline_start: 0,
  timeline_end: 10,
});
const right = clipRow({
  id: "right",
  source_start: 25,
  source_end: 40,
  timeline_start: 10,
  timeline_end: 25,
});

const meta: Meta<typeof EditBoundaryMarkView> = {
  title: "Templates/EditBoundaryMark",
  component: EditBoundaryMarkView,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <main aria-label="Edit boundary preview" className="transcript-list">
        <p className="utterance-seg">
          We found a clear signal after listening carefully to the room tone and
          comparing each take. <Story /> The next phrase starts cleanly and
          keeps the conversation moving.
        </p>
      </main>
    ),
  ],
  args: {
    boundary,
    presentation: resolveBoundaryPresentation(left, right),
    leftClip: left,
    rightClip: right,
    getRollInterval: () => rollJoinInterval([left, right], left.id, right.id),
    onRoll: fn(),
    onTrim: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof EditBoundaryMarkView>;

export const RollJoin: Story = {
  play: async ({ canvasElement }) => {
    const button = canvasElement.querySelector(
      "button[data-boundary-id]",
    ) as HTMLElement;
    await expect(button).toHaveClass("has-cutaway");
    await expect(button).toHaveAttribute(
      "aria-label",
      capabilityTooltip("daw.edit.rollClipJoin"),
    );
  },
};

export const RollDragPreview: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const mark = canvasElement.querySelector(
      "button[data-boundary-id]",
    ) as HTMLElement;
    void fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
    void fireEvent.pointerMove(window, { pointerId: 1, clientX: 180 });
    await expect(mark).toHaveAttribute("aria-grabbed", "true");
    await expect(
      canvas.getByRole("group", { name: "Preview restored words" }),
    ).toBeInTheDocument();
    await expect(
      canvasElement.ownerDocument.querySelector(".edit-boundary-delta"),
    ).toHaveTextContent("+1.00s");
    void fireEvent.pointerCancel(window, { pointerId: 1, clientX: 180 });
    await waitFor(() =>
      expect(mark).not.toHaveAttribute("aria-grabbed", "true"),
    );
  },
};

export const TrimEdge: Story = {
  args: {
    presentation: resolveBoundaryPresentation(left, null),
    rightClip: null,
    boundary: { ...boundary, right_clip_id: null },
  },
  play: async ({ canvasElement }) => {
    const button = canvasElement.querySelector(
      "button[data-boundary-id]",
    ) as HTMLElement;
    await expect(button).toHaveAttribute(
      "aria-label",
      TRANSCRIPT_EDIT_BOUNDARY_TIP,
    );
  },
};

export const HostOnlyPrecisionEdit: Story = {
  args: { canEdit: false },
  play: async ({ canvasElement }) => {
    const mark = within(canvasElement).getByRole("button");
    await expect(mark).toBeDisabled();
    await expect(mark).toHaveAccessibleName(/available to editors/i);
  },
};

export const PhoneWidth: Story = {
  parameters: { ...recordMobileViewport.parameters, phoneWidth: true },
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement }) => {
    const button = canvasElement.querySelector(
      "button[data-boundary-id]",
    ) as HTMLElement;
    await expect(button).toBeVisible();
  },
};

export const LongFailure: Story = {
  args: {
    onRoll: fn(async () => {
      throw new Error("Detailed server failure ".repeat(200));
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const mark = within(canvasElement).getByRole("button");
    const previousFetch = globalThis.fetch;
    const previousProjectPath = useDawStore.getState().projectPath;
    useDawStore.setState({ projectPath: "/tmp/story-project" });
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          target: {
            kind: "roll",
            left_clip_id: "left",
            right_clip_id: "right",
          },
          token: "story-token",
          track_id: "host",
          geometry: [left, right].map(
            ({ id, source_start, source_end, timeline_start, source_id }) => ({
              id,
              source_start,
              source_end,
              timeline_start,
              source_id,
            }),
          ),
          current: { source_sec: 20, timeline_sec: 10 },
          limits: {
            min: -1,
            max: 1,
            fine_step_sec: 0.001,
            regular_step_sec: 0.01,
          },
        }),
        { status: 200 },
      );
    try {
      await fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
      await fireEvent.pointerUp(window, { pointerId: 1, clientX: 180 });
      await waitFor(() =>
        expect(canvas.getByRole("alert")).toHaveTextContent(
          "Detailed server failure",
        ),
      );
      await expect(
        canvas.getByRole("button", { name: "Dismiss boundary error" }),
      ).toBeVisible();
    } finally {
      globalThis.fetch = previousFetch;
      useDawStore.setState({ projectPath: previousProjectPath });
    }
  },
};
