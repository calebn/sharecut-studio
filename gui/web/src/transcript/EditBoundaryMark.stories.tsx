import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, fn, waitFor, within } from "storybook/test";
import { capabilityTooltip } from "../capabilities/copy";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { clipRow } from "../test/fixtures";
import type { EditBoundaryView } from "../types/project";
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
    { track_id: "host", word_index: 3, text: "before", start: 20.1, end: 20.5 },
    { track_id: "host", word_index: 4, text: "we", start: 20.6, end: 20.8 },
    { track_id: "host", word_index: 5, text: "begin", start: 20.9, end: 21.2 },
  ],
};

const left = clipRow({
  id: "left",
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
          We found <Story /> the signal.
        </p>
      </main>
    ),
  ],
  args: {
    boundary,
    leftClip: left,
    rightClip: right,
    getRollBounds: () => ({
      prevSourceEnd: 0,
      nextSourceStart: 80,
      mediaEnd: 80,
    }),
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
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
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
      canvasElement.querySelector(".edit-boundary-delta"),
    ).toHaveTextContent("+1.0s");
    void fireEvent.pointerUp(window, { pointerId: 1, clientX: 180 });
    await waitFor(() => expect(args.onRoll).toHaveBeenCalled());
  },
};

export const TrimEdge: Story = {
  args: {
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
