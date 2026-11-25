import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  isolatedStoryParameters,
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { openDialogByLauncher } from "../../test/storyDialog";
import { Button } from "../../ui";
import { ApiError } from "../../utils/apiError";
import { SaveSegmentCard } from "./SaveSegmentCard";

const meta: Meta<typeof SaveSegmentCard> = {
  title: "Stages/Edit/SaveSegmentCard",
  component: SaveSegmentCard,
  tags: ["autodocs"],
  args: {
    summary: "3 clips, 0:22",
    defaultKind: "intro",
    onSave: fn(async () => {}),
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
          "The Save as segment card, opened from the Edit stage's More menu with a clip or a range selected. A Name field takes focus, a Kind select starts on the guess from where the selection sits (the first two minutes is Intro, the last two is Outro, anything else is Other), and a line says what is being saved, such as 3 clips, 0:22. Save writes a copy to the library, which is outside the project, so the toast that follows has no Undo. A refusal from the server is explained in plain words inside the card, which stays open. On a phone the same card is the bottom sheet.\n\nOn desktop it is an anchored Dialog beside the selection: focus goes to Name on open, Esc and a press outside close it, and focus returns to the anchor.\n\n**Motion.** None on the desktop card; the phone sheet slides with `--motion-panel`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SaveSegmentCard>;

function Anchored(
  args: Omit<
    React.ComponentProps<typeof SaveSegmentCard>,
    "anchorRef" | "form"
  >,
) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button ref={anchor} type="button" className="sys-actions-icon">
        Selected clips
      </button>
      <SaveSegmentCard
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
    const name = await card.findByRole("textbox", { name: "Name" });
    await waitFor(() => expect(name).toHaveFocus());
    await expect(card.getByRole("combobox", { name: "Kind" })).toHaveValue(
      "intro",
    );
    await waitFor(() => expect(card.getByText("3 clips, 0:22")).toBeVisible());
    await userEvent.click(card.getByRole("button", { name: "Save" }));
    await expect(await card.findByRole("alert")).toHaveTextContent(
      "Enter a name for the segment.",
    );
    await userEvent.type(name, "Cold open{Enter}");
    await expect(args.onSave).toHaveBeenCalledWith({
      name: "Cold open",
      kind: "intro",
    });
  },
};

export const Refused: Story = {
  args: {
    onSave: fn(async () => {
      throw new ApiError("raw", "segment_clip_too_short", 400);
    }),
  },
  render: (args) => <Anchored {...args} />,
  play: async ({ args }) => {
    const card = within(document.body);
    await userEvent.type(
      await card.findByRole("textbox", { name: "Name" }),
      "Cold open{Enter}",
    );
    await expect(await card.findByRole("alert")).toHaveTextContent(
      "A clip in this selection is too short to save.",
    );
    await expect(args.onClose).not.toHaveBeenCalled();
  },
};

function PhoneSheet(
  args: Omit<
    React.ComponentProps<typeof SaveSegmentCard>,
    "anchorRef" | "form" | "open"
  >,
) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Save as segment</Button>
      <SaveSegmentCard
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
      launcherName: "Save as segment",
      dialogName: "Save as segment",
    });
    const inside = within(dialog);
    await waitFor(() =>
      expect(inside.getByRole("textbox", { name: "Name" })).toHaveFocus(),
    );
    await expect(inside.getByRole("combobox", { name: "Kind" })).toHaveValue(
      "intro",
    );
  },
};
