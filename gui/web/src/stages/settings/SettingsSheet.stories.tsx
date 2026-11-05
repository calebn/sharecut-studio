import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { isolatedStoryParameters } from "../../storybook/storyLayout";
import { SettingsSheet } from "./SettingsSheet";

const meta: Meta<typeof SettingsSheet> = {
  title: "Stages/Settings/SettingsSheet",
  component: SettingsSheet,
  tags: ["autodocs"],
  args: {
    form: "centered",
    open: true,
    onClose: fn(),
    onModels: fn(),
  },
  parameters: {
    ...isolatedStoryParameters,
    docs: {
      ...isolatedStoryParameters.docs,
      description: {
        component:
          "Settings: Appearance (System, Light, Dark), Saved in with Reveal in folder while an episode is open, Models, and Keyboard shortcuts where the app has a reference. Choices apply as they are made. Reveal in folder shows only in the desktop app, which runs on the computer that holds the folder. The native Settings… menu item (Cmd+, on macOS, Ctrl+, elsewhere) opens this same sheet. Loudness lives in Deliver and vocabulary in Prepare, so they are not repeated here. A centred card on desktop, a bottom sheet on a phone.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SettingsSheet>;

export const Home: Story = {
  play: async ({ args, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = within(
      await within(document.body).findByRole("dialog", { name: "Settings" }),
    );
    await expect(sheet.queryByText("Saved in")).toBeNull();
    await expect(
      sheet.queryByRole("button", { name: /Keyboard shortcuts/ }),
    ).toBeNull();
    await userEvent.click(sheet.getByRole("button", { name: /Models/ }));
    await expect(args.onModels).toHaveBeenCalled();
  },
};

export const InProject: Story = {
  args: {
    projectFolder: "/Users/maya/ShareCut/Episode 14",
    onRevealFolder: fn(),
    onShortcuts: fn(),
  },
  play: async ({ args, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = within(
      await within(document.body).findByRole("dialog", { name: "Settings" }),
    );
    await expect(
      sheet.getByText("/Users/maya/ShareCut/Episode 14"),
    ).toBeVisible();
    await userEvent.click(
      sheet.getByRole("button", { name: "Reveal in folder" }),
    );
    await expect(args.onRevealFolder).toHaveBeenCalled();
    await userEvent.click(
      sheet.getByRole("button", { name: /Keyboard shortcuts/ }),
    );
    await expect(args.onShortcuts).toHaveBeenCalled();
  },
};

export const InBrowser: Story = {
  args: {
    projectFolder: "/Users/maya/ShareCut/Episode 14",
    onShortcuts: fn(),
  },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = within(
      await within(document.body).findByRole("dialog", { name: "Settings" }),
    );
    await expect(
      sheet.queryByRole("button", { name: "Reveal in folder" }),
    ).toBeNull();
  },
};

export const Phone: Story = {
  args: {
    form: "bottom",
    projectFolder: "/Users/maya/ShareCut/Episode 14",
    onRevealFolder: fn(),
    onShortcuts: fn(),
  },
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
