import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { recordMobileViewport } from "../../record/recordStoryDecorator";
import { openDialogViaLauncher } from "../../storybook/openDialog";
import { isolatedStoryParameters } from "../../storybook/storyLayout";
import { Button } from "../../ui";
import { CommandPaletteView } from "./CommandPaletteView";
import type { PaletteCommand } from "./paletteSearch";

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
    label: "Stop playback",
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
    note: "Mod+K cuts; K alone stops playback",
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
    label: "Bounce…",
    category: "ui",
    shortcut: "⌘+Shift+B",
    defaultKey: "B",
    disabledReason: null,
  },
  {
    id: "export.deliverables",
    label: "Export deliverables…",
    category: "ui",
    shortcut: "⌘+Shift+E",
    defaultKey: "E",
    disabledReason: null,
  },
  {
    id: "help.diagnosticsBundle",
    label: "Export diagnostics…",
    category: "ui",
    shortcut: null,
    disabledReason: "Project create/open is host-only",
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
        onOpenGestures={() => {
          setOpen(false);
          args.onOpenGestures();
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
    onOpenGestures: fn(),
    onRun: fn(),
    onRemap: fn(),
  },
  argTypes: { open: { control: false } },
  render: (args, context) => (
    <PalettePreview {...args} initiallyOpen={context.viewMode === "story"} />
  ),
};
export default meta;
type Story = StoryObj<typeof CommandPaletteView>;

export const Browse: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogViaLauncher(canvasElement, LAUNCHER, TITLE);
    await waitFor(() =>
      expect(within(dialog).getByText("Fit session width")).toBeVisible(),
    );
    await expect(
      within(dialog).getByRole("option", { name: "Export diagnostics…" }),
    ).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(
      within(dialog).getByRole("option", { name: "Fit session width" }),
    );
    await expect(args.onRun).toHaveBeenCalledWith("view.fit");
  },
};

export const Search: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogViaLauncher(canvasElement, LAUNCHER, TITLE);
    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "Search commands" }),
      "export",
    );
    await expect(within(dialog).getByRole("status")).toHaveTextContent(
      "2 commands. Enter runs Export deliverables…",
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
    await expect(
      within(dialog).getByRole("button", { name: "Clear search" }),
    ).toBeVisible();
  },
};

export const ShowRemaps: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogViaLauncher(canvasElement, LAUNCHER, TITLE);
    await userEvent.click(
      await within(dialog).findByRole("checkbox", { name: "Show remaps" }),
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole("checkbox", { name: "Show remaps" }),
      ).toBeChecked(),
    );
    const input = await within(dialog).findByRole("textbox", {
      name: "Remap Split at playhead",
    });
    await userEvent.click(input);
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.type(input, " B ");
    await userEvent.tab();
    await waitFor(() =>
      expect(args.onRemap).toHaveBeenCalledWith("edit.bladeCut", "B"),
    );
  },
};

export const GesturesHandoff: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogViaLauncher(canvasElement, LAUNCHER, TITLE);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Gestures" }),
    );
    await expect(args.onOpenGestures).toHaveBeenCalledOnce();
    await expect(within(document.body).queryByRole("dialog")).toBeNull();
  },
};

export const Phone: Story = {
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogViaLauncher(canvasElement, LAUNCHER, TITLE);
    await waitFor(() =>
      expect(within(dialog).getByText("Play / pause")).toBeVisible(),
    );
  },
};
