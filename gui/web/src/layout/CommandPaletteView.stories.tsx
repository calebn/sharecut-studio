import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { openDialogViaLauncher } from "../storybook/openDialog";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { Button } from "../ui";
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
    id: "tool.select",
    label: "Select tool",
    category: "tools",
    shortcut: "V",
    defaultKey: "V",
    disabledReason: null,
  },
  {
    id: "tool.blade",
    label: "Blade tool",
    category: "tools",
    shortcut: "C",
    defaultKey: "C",
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
      expect(within(dialog).getByText("Select tool")).toBeVisible(),
    );
    await expect(
      within(dialog).getByRole("button", { name: /^Export diagnostics…/ }),
    ).toBeDisabled();
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Select tool/ }),
    );
    await expect(args.onRun).toHaveBeenCalledWith("tool.select");
  },
};

export const Search: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogViaLauncher(canvasElement, LAUNCHER, TITLE);
    await userEvent.type(
      within(dialog).getByRole("searchbox", { name: "Search commands" }),
      "export",
    );
    await expect(within(dialog).getByRole("status")).toHaveTextContent(
      "2 commands",
    );
    await expect(within(dialog).queryByText("Select tool")).toBeNull();
    await userEvent.keyboard("{Enter}");
    await expect(args.onRun).toHaveBeenCalledWith("export.deliverables");
  },
};

export const NoMatch: Story = {
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogViaLauncher(canvasElement, LAUNCHER, TITLE);
    await userEvent.type(
      within(dialog).getByRole("searchbox", { name: "Search commands" }),
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
      within(dialog).getByRole("checkbox", { name: "Show remaps" }),
    );
    const input = within(dialog).getByRole("textbox", {
      name: "Remap Blade tool",
    });
    await userEvent.type(input, " B ");
    await userEvent.tab();
    await expect(args.onRemap).toHaveBeenCalledWith("tool.blade", "B");
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
