import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
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
    onAddSpeaker: fn(),
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
          "The speaker popover (spec POP-SPEAKER), opened from a turn's name in the Script margin: the people of the episode with a check on the turn's speaker, rows 44 px tall. Click, Space or Enter on a person moves the turn to that person's lane at once and closes the popover; the arrows only move the focus ring, so a keyboard user can reach every row. Fix text on a row turns the name into an inline field: Enter renames the person everywhere, Esc puts the name back, and leaving the field changes nothing. An empty name, or one another speaker has, stays in the field with the reason. Add speaker takes a new name the same way. There is no Save button, and one undo step covers each change. On a phone the same list is the bottom sheet.\n\nOn desktop it is an anchored Dialog beside the margin name that the pane's `onSpeaker` reports: focus goes to the current speaker on open, Esc and a press outside close it, it joins the overlay stack so the app keymap holds its keys, and focus returns to the margin name.\n\n**Motion.** None on the desktop card; the phone sheet slides with `--motion-panel`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SpeakerPopover>;

function Anchored(
  args: Omit<React.ComponentProps<typeof SpeakerPopover>, "anchorRef" | "form">,
) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  const [currentId, setCurrentId] = useState(args.currentId);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="sys-script-speaker"
        onClick={() => setOpen(true)}
      >
        Anneke de Vries
      </button>
      <SpeakerPopover
        {...args}
        form="anchored"
        anchorRef={anchor}
        open={open}
        currentId={currentId}
        onClose={() => {
          args.onClose();
          setOpen(false);
        }}
        onPick={(id) => {
          setCurrentId(id);
          return args.onPick(id);
        }}
      />
    </>
  );
}

const settled = () => new Promise<void>((done) => setTimeout(done, 80));

export const Open: Story = {
  render: (args) => <Anchored {...args} />,
  play: async ({ args }) => {
    const popover = within(document.body);
    await waitFor(() =>
      expect(popover.getByRole("radio", { name: /^Anneke/ })).toHaveFocus(),
    );
    await expect(popover.getByRole("radio", { name: /^Anneke/ })).toBeChecked();
    await expect(popover.queryByRole("button", { name: /save/i })).toBeNull();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await expect(popover.getByRole("radio", { name: /^Maya/ })).toHaveFocus();
    await expect(args.onPick).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    await expect(args.onPick).toHaveBeenCalledWith("maya");
    await waitFor(() => expect(popover.queryByRole("dialog")).toBeNull());
    await expect(
      popover.getByRole("button", { name: "Anneke de Vries" }),
    ).toHaveFocus();
  },
};

export const EscCloses: Story = {
  render: (args) => <Anchored {...args} />,
  play: async ({ args }) => {
    const popover = within(document.body);
    await waitFor(() =>
      expect(popover.getByRole("radio", { name: /^Anneke/ })).toHaveFocus(),
    );
    await userEvent.keyboard("{Escape}");
    await expect(args.onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(popover.queryByRole("dialog")).toBeNull());
    await expect(
      popover.getByRole("button", { name: "Anneke de Vries" }),
    ).toHaveFocus();
  },
};

export const Renaming: Story = {
  render: (args) => <Anchored {...args} initialRenamingId="joss" />,
  play: async ({ args }) => {
    const popover = within(document.body);
    const field = await popover.findByRole("textbox", {
      name: "Name for Joss",
    });
    await waitFor(() => expect(field).toHaveFocus());
    await settled();
    await userEvent.keyboard("Joss Hart{Escape}");
    await expect(args.onRename).not.toHaveBeenCalled();
    await expect(args.onClose).not.toHaveBeenCalled();
    await expect(
      popover.getByRole("button", {
        name: "Fix text, rename Joss everywhere",
      }),
    ).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Backspace}{Enter}");
    await expect(await popover.findByRole("alert")).toHaveTextContent(
      "Enter a speaker name.",
    );
    await userEvent.keyboard("Maya Okafor{Enter}");
    await expect(popover.getByRole("alert")).toHaveTextContent(
      "Another speaker already has that name.",
    );
    await userEvent.keyboard("{Control>}a{/Control}Joss Hart{Enter}");
    await expect(args.onRename).toHaveBeenCalledWith("joss", "Joss Hart");
    await expect(popover.queryByRole("textbox")).toBeNull();
  },
};

export const AddSpeaker: Story = {
  render: (args) => <Anchored {...args} />,
  play: async ({ args }) => {
    const popover = within(document.body);
    await waitFor(() =>
      expect(popover.getByRole("radio", { name: /^Anneke/ })).toHaveFocus(),
    );
    await settled();
    await userEvent.click(popover.getByRole("button", { name: "Add speaker" }));
    await expect(
      popover.getByRole("textbox", { name: "Name of the new speaker" }),
    ).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(await popover.findByRole("alert")).toHaveTextContent(
      "Enter a speaker name.",
    );
    await userEvent.keyboard("Priya Shah{Enter}");
    await expect(args.onAddSpeaker).toHaveBeenCalledWith("Priya Shah");
  },
};

function PhoneSheet(
  args: Omit<
    React.ComponentProps<typeof SpeakerPopover>,
    "anchorRef" | "form" | "open"
  >,
) {
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
      inside.getByRole("button", {
        name: "Fix text, rename Maya Okafor everywhere",
      }),
    );
    await waitFor(() =>
      expect(
        inside.getByRole("textbox", { name: "Name for Maya Okafor" }),
      ).toHaveFocus(),
    );
  },
};
