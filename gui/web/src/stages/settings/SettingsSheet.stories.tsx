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
          "Settings: Models, and Project settings while an episode is open. Project settings pushes a step inside the same sheet and shows where the episode is saved. Loudness lives in Deliver and vocabulary in Prepare, so they are not repeated here. A centred card on desktop, a bottom sheet on a phone.\n\n**Motion.** The pushed step slides in with `--motion-panel`.",
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
    await expect(
      sheet.queryByRole("button", { name: /Project settings/ }),
    ).toBeNull();
    await userEvent.click(sheet.getByRole("button", { name: /Models/ }));
    await expect(args.onModels).toHaveBeenCalled();
  },
};

export const InProject: Story = {
  args: { projectFolder: "/Users/maya/ShareCut/Episode 14" },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = within(
      await within(document.body).findByRole("dialog", { name: "Settings" }),
    );
    await userEvent.click(
      sheet.getByRole("button", { name: /Project settings/ }),
    );
    await expect(
      await within(document.body).findByRole("dialog", {
        name: "Project settings",
      }),
    ).toBeVisible();
    await expect(
      sheet.getByText("/Users/maya/ShareCut/Episode 14"),
    ).toBeVisible();
  },
};

export const Phone: Story = {
  args: { form: "bottom", projectFolder: "/Users/maya/ShareCut/Episode 14" },
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
