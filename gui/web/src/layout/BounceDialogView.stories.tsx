import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { DialogLauncher } from "../test/DialogLauncher";
import { openDialogByLauncher } from "../test/storyDialog";
import { BounceDialogView } from "./BounceDialogView";

const openDialog = (canvasElement: HTMLElement) =>
  openDialogByLauncher(canvasElement, {
    launcherName: "Open bounce dialog",
    dialogName: "Bounce…",
  });

function BounceDialogPreview({
  initiallyOpen,
  ...args
}: ComponentProps<typeof BounceDialogView> & { initiallyOpen: boolean }) {
  const [source, setSource] = useState(args.source);
  const [useRegion, setUseRegion] = useState(args.useRegion);
  const [includeMp3, setIncludeMp3] = useState(args.includeMp3);
  return (
    <DialogLauncher label="Open bounce dialog" initiallyOpen={initiallyOpen}>
      {(open, close) => (
        <BounceDialogView
          {...args}
          open={open}
          source={source}
          useRegion={useRegion}
          includeMp3={includeMp3}
          onClose={() => {
            close();
            args.onClose();
          }}
          onSourceChange={(next) => {
            setSource(next);
            args.onSourceChange(next);
          }}
          onUseRegionChange={(next) => {
            setUseRegion(next);
            args.onUseRegionChange(next);
          }}
          onIncludeMp3Change={(next) => {
            setIncludeMp3(next);
            args.onIncludeMp3Change(next);
          }}
        />
      )}
    </DialogLauncher>
  );
}

const meta: Meta<typeof BounceDialogView> = {
  title: "Templates/BounceDialog",
  component: BounceDialogView,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    open: false,
    onClose: fn(),
    source: "entire",
    onSourceChange: fn(),
    selectedCount: 2,
    soloCount: 1,
    hasRegion: true,
    useRegion: false,
    onUseRegionChange: fn(),
    includeMp3: false,
    onIncludeMp3Change: fn(),
    busy: false,
    error: null,
    onBounce: fn(),
  },
  argTypes: { open: { control: false } },
  render: (args, context) => (
    <BounceDialogPreview
      {...args}
      initiallyOpen={context.viewMode === "story"}
    />
  ),
};

export default meta;
type Story = StoryObj<typeof BounceDialogView>;

export const Ready: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await userEvent.click(within(dialog).getByLabelText("Selected tracks (2)"));
    await userEvent.click(within(dialog).getByLabelText("Also write MP3"));
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Bounce" }),
    );
    await expect(args.onBounce).toHaveBeenCalledOnce();
    await expect(
      within(dialog).getByLabelText("Selected tracks (2)"),
    ).toBeChecked();
  },
};

export const NoRegion: Story = {
  args: { hasRegion: false },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByLabelText(
        /Limit to session region \(no region set\)/,
      ),
    ).toBeDisabled();
  },
};

export const Bouncing: Story = {
  args: { busy: true },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByRole("button", { name: "Bouncing…" }),
    ).toBeDisabled();
  },
};

export const NothingSelected: Story = {
  args: {
    source: "selected",
    selectedCount: 0,
    error: "Select one or more tracks first",
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByText("Select one or more tracks first"),
    ).toBeVisible();
  },
};

export const Phone: Story = {
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(dialog).toBeVisible();
  },
};
