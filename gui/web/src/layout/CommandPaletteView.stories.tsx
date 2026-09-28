import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { Button } from "../ui";
import { CommandPaletteView } from "./CommandPaletteView";
import type {
  CommandPaletteAction,
  CommandPaletteCategory,
} from "./commandPaletteRows";

/** Fixed, representative rows (the live adapter builds these from the keymap registry); commandPaletteRows.test.ts checks ids, labels, categories and default keys against the registry and catalog. */
const CATEGORIES: CommandPaletteCategory[] = [
  {
    category: "transport",
    rows: [
      {
        id: "transport.togglePlay",
        label: "Play / pause",
        shortcut: "Space",
        defaultKey: " ",
      },
      {
        id: "transport.stop",
        label: "Stop playback",
        shortcut: "K",
        defaultKey: "K",
      },
    ],
  },
  {
    category: "tools",
    rows: [
      {
        id: "tool.select",
        label: "Select tool",
        shortcut: "V",
        defaultKey: "V",
      },
      { id: "tool.blade", label: "Blade tool", shortcut: "C", defaultKey: "C" },
    ],
  },
  {
    category: "review",
    rows: [
      {
        id: "review.toggleCommentMode",
        label: "Toggle comment mode",
        shortcut: "⌘+Shift+C",
        defaultKey: "C",
      },
    ],
  },
];

const UNBOUND: CommandPaletteAction[] = [
  { id: "view.fitTracksHeight", label: "Fit tracks to window height" },
];

function PalettePreview({
  initiallyOpen,
  ...args
}: ComponentProps<typeof CommandPaletteView> & { initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        Open keyboard shortcuts
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
  parameters: { layout: "padded" },
  args: {
    open: false,
    categories: CATEGORIES,
    unbound: UNBOUND,
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

async function openPalette(canvasElement: HTMLElement) {
  if (!within(document.body).queryByRole("dialog")) {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Open keyboard shortcuts",
      }),
    );
  }
  return within(document.body).getByRole("dialog", {
    name: "Keyboard shortcuts",
  });
}

export const AllKeys: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openPalette(canvasElement);
    await waitFor(() =>
      expect(within(dialog).getByText("Select tool")).toBeVisible(),
    );
    await expect(
      within(dialog).getByText("Commands without keys"),
    ).toBeVisible();
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Select tool/ }),
    );
    await expect(args.onRun).toHaveBeenCalledWith("tool.select");
  },
};

export const CategoryTab: Story = {
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openPalette(canvasElement);
    await userEvent.click(within(dialog).getByRole("tab", { name: "tools" }));
    await expect(
      within(dialog).getByRole("tab", { name: "tools" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(within(dialog).getByText("Blade tool")).toBeVisible();
    await expect(within(dialog).queryByText("Play / pause")).toBeNull();
    await expect(
      within(dialog).queryByText("Commands without keys"),
    ).toBeNull();
  },
};

export const ActionsTab: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openPalette(canvasElement);
    await userEvent.click(within(dialog).getByRole("tab", { name: "Actions" }));
    await expect(within(dialog).queryByText("Select tool")).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: /Fit tracks to window height/,
      }),
    );
    await expect(args.onRun).toHaveBeenCalledWith("view.fitTracksHeight");
  },
};

export const ShowRemaps: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openPalette(canvasElement);
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
    const dialog = await openPalette(canvasElement);
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
    const dialog = await openPalette(canvasElement);
    await waitFor(() =>
      expect(within(dialog).getByText("Play / pause")).toBeVisible(),
    );
  },
};
