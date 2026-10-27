import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  isolatedStoryParameters,
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { PEOPLE } from "../../system/prepareFixtures";
import { openDialogByLauncher } from "../../test/storyDialog";
import { Button } from "../../ui";
import { SpeakerPopover } from "./SpeakerPopover";

const meta: Meta<typeof SpeakerPopover> = {
  title: "Stages/Edit/SpeakerPopover",
  component: SpeakerPopover,
  tags: ["autodocs"],
  args: {
    people: PEOPLE,
    currentId: "anneke",
    onPick: fn(),
    onRename: fn(),
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
          "The speaker popover (spec POP-SPEAKER), opened from a turn's name in the Script margin: the people of the episode in a Sheet, a check on the turn's speaker, rows 44 px tall. Picking another person moves the turn to that person's lane at once. Fix text on a row turns the name into an inline field: Enter renames the person everywhere, Esc puts the name back, and focus returns to that row's Fix text button. There is no Save button, and one undo step covers either change. On a phone the same list is the bottom sheet.\n\nThe host anchors the card to the margin name that the pane's `onSpeaker` reports and closes it after a pick; Esc and an outside press close it through the anchored-panel hook.\n\n**Motion.** None on the desktop card; the phone sheet slides with `--motion-panel`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SpeakerPopover>;

function Picking(args: React.ComponentProps<typeof SpeakerPopover>) {
  const [currentId, setCurrentId] = useState(args.currentId);
  return (
    <SpeakerPopover
      {...args}
      currentId={currentId}
      onPick={(id) => {
        setCurrentId(id);
        args.onPick(id);
      }}
    />
  );
}

export const Open: Story = {
  render: (args) => <Picking {...args} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("radio", { name: /^Anneke/ })).toBeChecked();
    await userEvent.click(canvas.getByRole("radio", { name: /^Maya/ }));
    await expect(args.onPick).toHaveBeenCalledWith("maya");
    await expect(canvas.getByRole("radio", { name: /^Maya/ })).toBeChecked();
    await expect(canvas.queryByRole("button", { name: /save/i })).toBeNull();
  },
};

export const Renaming: Story = {
  args: { initialRenamingId: "joss" },
  render: (args) => <Picking {...args} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByRole("textbox", { name: "Name for Joss" });
    await expect(field).toHaveFocus();
    await userEvent.keyboard("Joss Hart{Escape}");
    await expect(args.onRename).not.toHaveBeenCalled();
    await expect(
      canvas.getByRole("button", { name: "Fix text for Joss" }),
    ).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("Joss Hart{Enter}");
    await expect(args.onRename).toHaveBeenCalledWith("joss", "Joss Hart");
    await expect(canvas.queryByRole("textbox")).toBeNull();
  },
};

function PhoneSheet(args: React.ComponentProps<typeof SpeakerPopover>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Change speaker</Button>
      <SpeakerPopover
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
      launcherName: "Change speaker",
      dialogName: "Speaker",
    });
    const inside = within(dialog);
    await expect(inside.getByRole("radio", { name: /^Anneke/ })).toBeChecked();
    await userEvent.click(
      inside.getByRole("button", { name: "Fix text for Maya Okafor" }),
    );
    await waitFor(() =>
      expect(
        inside.getByRole("textbox", { name: "Name for Maya Okafor" }),
      ).toHaveFocus(),
    );
  },
};
