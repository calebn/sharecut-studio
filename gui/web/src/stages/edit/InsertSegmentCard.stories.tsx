import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  insertPreview,
  LIBRARY,
  PLACEMENT_LIBRARY,
} from "../../segments/fixtures";
import {
  isolatedStoryParameters,
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { openDialogByLauncher } from "../../test/storyDialog";
import { Button } from "../../ui";
import { ApiError } from "../../utils/apiError";
import { InsertSegmentCard } from "./InsertSegmentCard";

const meta: Meta<typeof InsertSegmentCard> = {
  title: "Stages/Edit/InsertSegmentCard",
  component: InsertSegmentCard,
  tags: ["autodocs"],
  args: {
    rows: LIBRARY,
    loadError: null,
    onRetryLoad: fn(),
    playheadSec: 42,
    timelineEnd: 600,
    loadPreview: fn(async (request) =>
      insertPreview({
        segment_id: request.segment_id,
        at: typeof request.at === "number" ? request.at : 0,
      }),
    ),
    onInsert: fn(async () => {}),
    onClose: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          'The Insert segment card, opened from the Action bar at the playhead or from More with a clip or range selected. A list shows every segment in the library; one whose newest version cannot be read is listed with its problem and cannot be picked. Position starts on the guess from the kind (an intro goes to the start, an outro to the end, anything else to the playhead). Every pick or position change asks the server for a preview, and Insert stays off until that preview is back. Above Position, "What happens to the episode" offers Move the rest later (the default for every segment; later clips, chapters and comments shift) or Play over the episode (nothing moves and the segment gets its own track, never offered for a dialogue segment). The choice resets when another segment is picked, and the preview says what each choice changes, including that an own-track segment plays at full level until it is ducked. The toast that follows has Undo.\n\nOn desktop it is an anchored Dialog beside the Action bar: focus goes to the list on open, Esc and a press outside close it, and focus returns to the anchor. On a phone the same card is the bottom sheet.\n\n**Motion.** None on the desktop card; the phone sheet slides with `--motion-panel`.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof InsertSegmentCard>;

function Anchored(
  args: Omit<
    React.ComponentProps<typeof InsertSegmentCard>,
    "anchorRef" | "form"
  >,
) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button ref={anchor} type="button" className="sys-actions-icon">
        Insert segment
      </button>
      <InsertSegmentCard
        {...args}
        form="anchored"
        anchorRef={anchor}
        open={open}
        onClose={() => {
          args.onClose();
          setOpen(false);
        }}
      />
    </>
  );
}

export const Open: Story = {
  tags: ["storybook-only"],
  render: (args) => <Anchored {...args} />,
  play: async ({ args }) => {
    const card = within(document.body);
    const first = await card.findByRole("radio", { name: /Cold open/ });
    await waitFor(() => expect(first).toHaveFocus());
    await expect(
      card.getByRole("radio", { name: /outro-77de/ }),
    ).toBeDisabled();
    await userEvent.click(first);
    await expect(card.getByRole("combobox", { name: "Position" })).toHaveValue(
      "start",
    );
    await expect(await card.findByText("Adds 0:22 at 0:00.")).toBeVisible();
    await userEvent.click(card.getByRole("button", { name: "Insert" }));
    await expect(args.onInsert).toHaveBeenCalledWith({
      name: "Cold open",
      request: { segment_id: "intro-9f3a", at: "start", version: 1 },
    });
  },
};

export const Refused: Story = {
  args: {
    onInsert: fn(async () => {
      throw new ApiError("raw", "segment_hash_mismatch", 409);
    }),
  },
  render: (args) => <Anchored {...args} />,
  play: async ({ args }) => {
    const card = within(document.body);
    await userEvent.click(
      await card.findByRole("radio", { name: /Cold open/ }),
    );
    await card.findByText(/Preview, from the saved episode/);
    await userEvent.click(card.getByRole("button", { name: "Insert" }));
    await expect(await card.findByRole("alert")).toHaveTextContent(
      "The audio of that segment has changed since it was saved.",
    );
    await expect(args.onClose).not.toHaveBeenCalled();
  },
};

export const OwnLane: Story = {
  args: { rows: PLACEMENT_LIBRARY },
  render: (args) => <Anchored {...args} />,
  play: async ({ args }) => {
    const card = within(document.body);
    await userEvent.click(await card.findByRole("radio", { name: /Warm bed/ }));
    await expect(
      card.getByRole("radio", { name: /Move the rest later/ }),
    ).toBeChecked();
    await userEvent.click(
      card.getByRole("radio", { name: /Play over the episode/ }),
    );
    await expect(
      await card.findByText("Adds 0:22 at 0:42 on a new track."),
    ).toBeVisible();
    await expect(
      card.getByText("Nothing already in the episode moves."),
    ).toBeVisible();
    await userEvent.click(card.getByRole("button", { name: "Insert" }));
    await expect(args.onInsert).toHaveBeenCalledWith({
      name: "Warm bed",
      request: {
        segment_id: "bed-5c1d",
        at: 42,
        version: 1,
        placement: "own_lane",
      },
    });
  },
};

export const OwnLaneDialogueDisabled: Story = {
  args: { rows: PLACEMENT_LIBRARY },
  render: (args) => <Anchored {...args} />,
  play: async () => {
    const card = within(document.body);
    await userEvent.click(
      await card.findByRole("radio", { name: /Host read/ }),
    );
    await expect(
      card.getByRole("radio", { name: /Play over the episode/ }),
    ).toBeDisabled();
    await expect(
      card.getByText(
        "Dialogue segments always move later content. They cannot have their own lane.",
      ),
    ).toBeVisible();
  },
};

export const PlacementUnsupported: Story = {
  args: {
    rows: PLACEMENT_LIBRARY,
    onInsert: fn(async () => {
      throw new ApiError("raw", "segment_placement_unsupported", 400);
    }),
  },
  render: (args) => <Anchored {...args} />,
  play: async ({ args }) => {
    const card = within(document.body);
    await userEvent.click(await card.findByRole("radio", { name: /Warm bed/ }));
    await userEvent.click(
      card.getByRole("radio", { name: /Play over the episode/ }),
    );
    await card.findByText(/on a new track/);
    await userEvent.click(card.getByRole("button", { name: "Insert" }));
    await expect(await card.findByRole("alert")).toHaveTextContent(
      "Dialogue segments cannot have their own lane. Choose Move the rest later.",
    );
    await expect(
      card.getByRole("radio", { name: /Move the rest later/ }),
    ).toBeChecked();
    await expect(args.onClose).not.toHaveBeenCalled();
  },
};

export const Empty: Story = {
  args: { rows: [] },
  render: (args) => <Anchored {...args} />,
  play: async () => {
    const note = await within(document.body).findByText(
      /Your library is empty/,
    );
    await waitFor(() => expect(note).toBeVisible());
  },
};

function PhoneSheet(
  args: Omit<
    React.ComponentProps<typeof InsertSegmentCard>,
    "anchorRef" | "form" | "open"
  >,
) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Insert segment</Button>
      <InsertSegmentCard
        {...args}
        form="bottom"
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

export const Phone: Story = {
  parameters: isolatedStoryParameters,
  render: (args) => <PhoneSheet {...args} />,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogByLauncher(canvasElement, {
      launcherName: "Insert segment",
      dialogName: "Insert segment",
    });
    const inside = within(dialog);
    await waitFor(() =>
      expect(inside.getByRole("radio", { name: /Cold open/ })).toHaveFocus(),
    );
    await userEvent.click(inside.getByRole("radio", { name: /Cold open/ }));
    await expect(await inside.findByText("Adds 0:22 at 0:00.")).toBeVisible();
  },
};
