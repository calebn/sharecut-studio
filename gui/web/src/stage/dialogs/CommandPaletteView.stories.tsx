import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { recordMobileViewport } from "../../record/recordStoryDecorator";
import { openDialogViaLauncher } from "../../storybook/openDialog";
import { isolatedStoryParameters } from "../../storybook/storyLayout";
import { Button } from "../../ui";
import { CommandPaletteView } from "./CommandPaletteView";
import {
  PALETTE_GESTURES,
  type PaletteCommand,
  type PaletteEntry,
} from "./paletteSearch";

/** Fixed, representative rows (the live adapter builds them from the catalog and keymap); commandPaletteRows.test.ts checks ids, labels, categories and default keys against both. */
const COMMANDS: PaletteCommand[] = [
  {
    id: "transport.togglePlay",
    label: "Play / pause",
    category: "transport",
    shortcut: "Space",
    defaultKey: " ",
    disabledReason: null,
  },
  {
    id: "transport.stop",
    label: "Pause and return",
    category: "transport",
    shortcut: "K",
    defaultKey: "K",
    disabledReason: null,
  },
  {
    id: "view.fit",
    label: "Fit session width",
    category: "view",
    shortcut: "\\",
    defaultKey: "\\",
    disabledReason: null,
  },
  {
    id: "edit.bladeCut",
    label: "Split at playhead",
    category: "edit",
    shortcut: "Mod+K",
    defaultKey: "K",
    note: "Mod+K cuts; K alone pauses and returns",
    disabledReason: null,
  },
  {
    id: "view.fitTracksHeight",
    label: "Fit tracks to window height",
    category: "view",
    shortcut: null,
    disabledReason: null,
  },
  {
    id: "export.bounce",
    label: "Export full mix",
    category: "ui",
    shortcut: null,
    defaultKey: undefined,
    disabledReason: null,
  },
  {
    id: "export.deliverables",
    label: "Export deliverables…",
    category: "ui",
    shortcut: "⌘E",
    defaultKey: "E",
    disabledReason: null,
  },
  {
    id: "stage.edit",
    label: "Go to Edit",
    category: "navigation",
    shortcut: "Ctrl+3",
    defaultKey: "3",
    group: "stages",
    icon: "stage-edit",
    disabledReason: null,
  },
  {
    id: "stage.deliver",
    label: "Go to Deliver",
    category: "navigation",
    shortcut: "Ctrl+5",
    defaultKey: "5",
    group: "stages",
    icon: "send",
    disabledReason: "Not available on this link",
  },
  {
    id: "help.diagnosticsBundle",
    label: "Report a problem…",
    category: "ui",
    shortcut: null,
    group: "help",
    disabledReason: "Project create/open is host-only",
  },
];

/** Representative Projects, People and Chapters rows (the live adapter is `paletteEntries`). */
const ENTRIES: PaletteEntry[] = [
  {
    id: "project:/episodes/finale",
    group: "projects",
    label: "Season finale",
    context: "Ready to deliver",
    verb: "Open",
    commandId: "project.open",
    args: { path: "/episodes/finale" },
  },
  {
    id: "person:c1",
    group: "people",
    label: "Ana",
    context: "editor",
    verb: "Follow",
    commandId: "presence.follow",
    args: { clientId: "c1" },
  },
  {
    id: "chapter:62:Cold open",
    group: "chapters",
    label: "Cold open",
    context: "1:02",
    verb: "Go to",
    commandId: "transport.seek",
    args: { sec: 62 },
  },
];

const LAUNCHER = "Open commands and shortcuts";
const TITLE = "Commands and shortcuts";

function PalettePreview({
  initiallyOpen,
  ...args
}: ComponentProps<typeof CommandPaletteView> & { initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {LAUNCHER}
      </Button>
      <CommandPaletteView
        {...args}
        open={open}
        onClose={() => {
          setOpen(false);
          args.onClose();
        }}
      />
    </>
  );
}

const meta: Meta<typeof CommandPaletteView> = {
  title: "Templates/CommandPalette",
  component: CommandPaletteView,
  tags: ["autodocs"],
  parameters: { ...isolatedStoryParameters, layout: "padded" },
  args: {
    open: false,
    commands: COMMANDS,
    onClose: fn(),
    onRun: fn(),
    onRemap: fn(),
    onRunEntry: fn(),
  },
  argTypes: { open: { control: false } },
  render: (args, context) => (
    <PalettePreview {...args} initiallyOpen={context.viewMode === "story"} />
  ),
};
export default meta;
type Story = StoryObj<typeof CommandPaletteView>;

export const Empty: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogViaLauncher(canvasElement, LAUNCHER, TITLE);
    await waitFor(() =>
      expect(within(dialog).getByText("Fit session width")).toBeVisible(),
    );
    await expect(
      within(dialog).getByRole("option", {
        name: "Report a problem… Project create/open is host-only",
      }),
    ).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(
      within(dialog).getByRole("option", { name: "Fit session width \\" }),
    );
    await expect(args.onRun).toHaveBeenCalledWith("view.fit");
  },
};

export const Groups: Story = {
  args: { entries: ENTRIES, gestures: PALETTE_GESTURES },
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogViaLauncher(canvasElement, LAUNCHER, TITLE);
    for (const name of [
      "Stages",
      "Projects",
      "People",
      "Chapters",
      "Gestures",
      "Help",
    ]) {
      await waitFor(() =>
        expect(within(dialog).getByRole("group", { name })).toBeVisible(),
      );
    }
    await expect(
      within(dialog).getByRole("option", {
        name: "Go to Deliver Ctrl+5 Not available on this link",
      }),
    ).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(
      within(dialog).getByRole("option", { name: "Go to Edit Ctrl+3" }),
    );
    await expect(args.onRun).toHaveBeenCalledWith("stage.edit");
    await userEvent.click(
      within(dialog).getByRole("option", { name: "Cold open 1:02" }),
    );
    await expect(args.onRunEntry).toHaveBeenCalledWith(ENTRIES[2]);
    const gestures = within(dialog).getByRole("group", { name: "Gestures" });
    await expect(within(gestures).queryAllByRole("option")).toHaveLength(0);
    const undo = within(gestures).getAllByRole("listitem")[0];
    await expect(undo).toHaveTextContent(
      "Undo Two-finger tap Undo the last action. Optional ShareCut shortcut.",
    );
    await userEvent.click(undo);
    await expect(args.onRun).toHaveBeenCalledTimes(1);
  },
};

const HOME_COMMANDS: PaletteCommand[] = [
  {
    id: "mcp.connect",
    label: "Connect agent…",
    category: "ui",
    shortcut: null,
    disabledReason: null,
  },
  {
    id: "help.diagnosticsBundle",
    label: "Report a problem…",
    category: "ui",
    shortcut: null,
    group: "help",
    disabledReason: null,
  },
  {
    id: "help.guides",
    label: "Guides",
    category: "ui",
    shortcut: null,
    group: "help",
    disabledReason: null,
  },
  {
    id: "models.open",
    label: "Manage models…",
    category: "ui",
    shortcut: null,
    disabledReason: null,
  },
];

export const HomeHelp: Story = {
  args: { commands: HOME_COMMANDS, leadGroup: "help" },
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogViaLauncher(canvasElement, LAUNCHER, TITLE);
    await waitFor(() =>
      expect(within(dialog).getByRole("group", { name: "Help" })).toBeVisible(),
    );
    await expect(within(dialog).queryByText("Play / pause")).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("option", { name: "Guides" }),
    );
    await expect(args.onRun).toHaveBeenCalledWith("help.guides");
  },
};

export const Recent: Story = {
  args: { entries: ENTRIES, recent: ["chapter:62:Cold open", "view.fit"] },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogViaLauncher(canvasElement, LAUNCHER, TITLE);
    const recent = within(dialog).getByRole("group", { name: "Recent" });
    await expect(within(recent).getAllByRole("option")).toHaveLength(2);
    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "Search commands" }),
      "fit",
    );
    await expect(
      within(dialog).queryByRole("group", { name: "Recent" }),
    ).toBeNull();
  },
};

export const Search: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogViaLauncher(canvasElement, LAUNCHER, TITLE);
    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "Search commands" }),
      "deliverables",
    );
    await expect(within(dialog).getByRole("status")).toHaveTextContent(
      "1 command. Enter runs Export deliverables…. Tab remaps",
    );
    await expect(within(dialog).queryByText("Split at playhead")).toBeNull();
    await userEvent.keyboard("{Enter}");
    await expect(args.onRun).toHaveBeenCalledWith("export.deliverables");
  },
};

export const NoMatch: Story = {
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogViaLauncher(canvasElement, LAUNCHER, TITLE);
    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "Search commands" }),
      "xylophone",
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Clear search" }),
      ).toBeVisible(),
    );
  },
};

export const Remap: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogViaLauncher(canvasElement, LAUNCHER, TITLE);
    const search = within(dialog).getByRole("combobox", {
      name: "Search commands",
    });
    await userEvent.type(search, "split");
    await expect(within(dialog).getByRole("status")).toHaveTextContent(
      "1 command. Enter runs Split at playhead. Tab remaps",
    );
    await userEvent.keyboard("{Tab}");
    const input = await within(dialog).findByRole("textbox", {
      name: "Remap Split at playhead",
    });
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.type(input, " B {Enter}");
    await waitFor(() =>
      expect(args.onRemap).toHaveBeenCalledWith("edit.bladeCut", "B"),
    );
    await waitFor(() => expect(search).toHaveFocus());
  },
};

export const Phone: Story = {
  args: { gestures: PALETTE_GESTURES },
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogViaLauncher(canvasElement, LAUNCHER, TITLE);
    await waitFor(() =>
      expect(within(dialog).getByText("Play / pause")).toBeVisible(),
    );
    await expect(
      within(dialog).getByRole("group", { name: "Gestures" }),
    ).toBeInTheDocument();
  },
};
