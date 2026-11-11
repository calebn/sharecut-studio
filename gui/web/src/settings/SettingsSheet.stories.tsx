import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { DialogLauncher } from "../test/DialogLauncher";
import { openDialogByLauncher, useArgState } from "../test/storyDialog";
import { SettingsSheet } from "./SettingsSheet";

const openSheet = (canvasElement: HTMLElement) =>
  openDialogByLauncher(canvasElement, {
    launcherName: "Open settings",
    dialogName: "Settings",
  });

const FOLDER = "/Users/mira/Podcasts/The Long Way Round/ep-12";

function SettingsPreview({
  initiallyOpen,
  ...args
}: ComponentProps<typeof SettingsSheet> & { initiallyOpen: boolean }) {
  const [theme, setTheme] = useArgState(args.theme);
  return (
    <DialogLauncher label="Open settings" initiallyOpen={initiallyOpen}>
      {(open, close) => (
        <SettingsSheet
          {...args}
          open={open}
          theme={theme}
          onTheme={(next) => {
            setTheme(next);
            args.onTheme(next);
          }}
          onClose={() => {
            close();
            args.onClose();
          }}
        />
      )}
    </DialogLauncher>
  );
}

const meta: Meta<typeof SettingsSheet> = {
  title: "Stages/Settings/SettingsSheet",
  component: SettingsSheet,
  tags: ["autodocs"],
  parameters: {
    ...isolatedStoryParameters,
    layout: "padded",
    docs: {
      ...isolatedStoryParameters.docs,
      description: {
        component:
          "Settings from the app menu: Appearance (System, Light, Dark, shared with the Project menu), Saved in with Reveal in folder and Move… (desktop app only), and the rows that open Models and Keyboard shortcuts. A 420 px sheet on the right of a desktop or tablet, a bottom sheet as tall as its rows on a phone. On Home there is no project, so Saved in and Keyboard shortcuts are absent. Rows act as they change; there is no Apply.",
      },
    },
  },
  args: {
    open: false,
    onClose: fn(),
    phone: false,
    theme: "system",
    onTheme: fn(),
    onOpenModels: fn(),
    onOpenShortcuts: fn(),
    savedIn: {
      folder: FOLDER,
      onReveal: fn(),
      onMove: fn(),
      revealing: false,
      error: null,
    },
  },
  argTypes: { open: { control: false } },
  render: (args, context) => (
    <SettingsPreview {...args} initiallyOpen={context.viewMode === "story"} />
  ),
};

export default meta;
type Story = StoryObj<typeof SettingsSheet>;

export const InProject: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = await openSheet(canvasElement);
    await expect(within(sheet).getByTitle(FOLDER)).toBeVisible();
    await userEvent.click(within(sheet).getByRole("radio", { name: "Dark" }));
    await expect(args.onTheme).toHaveBeenCalledWith("dark");
    await expect(
      within(sheet).getByRole("radio", { name: "Dark" }),
    ).toBeChecked();
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Reveal in folder" }),
    );
    await expect(args.savedIn?.onReveal).toHaveBeenCalledOnce();
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Models" }),
    );
    await expect(args.onOpenModels).toHaveBeenCalledOnce();
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Keyboard shortcuts" }),
    );
    await expect(args.onOpenShortcuts).toHaveBeenCalledOnce();
  },
};

export const Browser: Story = {
  args: {
    savedIn: { folder: FOLDER, revealing: false, error: null },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = await openSheet(canvasElement);
    await expect(within(sheet).getByTitle(FOLDER)).toBeVisible();
    await expect(
      within(sheet).queryByRole("button", { name: "Reveal in folder" }),
    ).toBeNull();
  },
};

export const LongFolder: Story = {
  args: {
    savedIn: {
      folder:
        "/Users/mira/Library/Mobile Documents/com~apple~CloudDocs/Podcasts/The Long Way Round/Season 2/ep-12",
      onReveal: fn(),
      revealing: false,
      error: null,
    },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = await openSheet(canvasElement);
    const path = within(sheet).getByText(/Season 2\/ep-12$/);
    await expect(path).toHaveAttribute(
      "title",
      expect.stringContaining("CloudDocs"),
    );
    await expect(path.textContent).toContain("…");
  },
};

export const Home: Story = {
  args: { savedIn: undefined, onOpenShortcuts: undefined },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = await openSheet(canvasElement);
    await expect(
      within(sheet).queryByRole("heading", { name: "Saved in" }),
    ).toBeNull();
    await expect(
      within(sheet).queryByRole("button", { name: "Keyboard shortcuts" }),
    ).toBeNull();
    await expect(
      within(sheet).getByRole("button", { name: "Models" }),
    ).toBeVisible();
  },
};

export const Revealing: Story = {
  args: {
    savedIn: {
      folder: FOLDER,
      onReveal: fn(),
      revealing: true,
      error: null,
    },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = await openSheet(canvasElement);
    await expect(
      within(sheet).getByRole("button", { name: "Revealing…" }),
    ).toBeDisabled();
  },
};

export const RevealError: Story = {
  args: {
    savedIn: {
      folder: FOLDER,
      onReveal: fn(),
      revealing: false,
      error: "This computer couldn't open its file manager.",
    },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = await openSheet(canvasElement);
    await expect(
      within(sheet).getByText("This computer couldn't open its file manager."),
    ).toBeVisible();
  },
};

export const Moving: Story = {
  args: {
    savedIn: {
      folder: FOLDER,
      onReveal: fn(),
      onMove: fn(),
      revealing: false,
      moving: true,
      error: null,
    },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = await openSheet(canvasElement);
    await expect(
      within(sheet).getByRole("button", { name: "Moving…" }),
    ).toBeDisabled();
  },
};

export const MoveRefused: Story = {
  args: {
    savedIn: {
      folder: FOLDER,
      onReveal: fn(),
      onMove: fn(),
      revealing: false,
      error:
        "Some edits are still waiting to be saved. Wait for them to finish, then move the episode.",
    },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = await openSheet(canvasElement);
    await expect(
      within(sheet).getByText(
        "Some edits are still waiting to be saved. Wait for them to finish, then move the episode.",
      ),
    ).toBeVisible();
  },
};

export const Phone: Story = {
  args: { phone: true },
  globals: { viewport: { value: "mobile360", isRotated: false } },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = await openSheet(canvasElement);
    await expect(
      within(sheet).getByRole("button", { name: "Keyboard shortcuts" }),
    ).toBeVisible();
  },
};
