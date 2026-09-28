import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { expect, fn, waitFor, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { DialogLauncher } from "../test/DialogLauncher";
import { openDialogByLauncher } from "../test/storyDialog";
import { HostMcpDialog } from "./HostMcpDialog";
import { mcpClientSnippet } from "./hostMcp";

const previewUrl = "http://127.0.0.1:8765/mcp";

const openDialog = (canvasElement: HTMLElement) =>
  openDialogByLauncher(canvasElement, {
    launcherName: "Open agent connection",
    dialogName: "Connect agent",
  });

function HostMcpPreview({
  initiallyOpen,
  ...args
}: ComponentProps<typeof HostMcpDialog> & { initiallyOpen: boolean }) {
  return (
    <DialogLauncher label="Open agent connection" initiallyOpen={initiallyOpen}>
      {(open, close) => (
        <HostMcpDialog
          {...args}
          open={open}
          onClose={() => {
            close();
            args.onClose();
          }}
        />
      )}
    </DialogLauncher>
  );
}

const meta: Meta<typeof HostMcpDialog> = {
  title: "Templates/HostMcpDialog",
  component: HostMcpDialog,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    open: false,
    onClose: fn(),
    hasProject: true,
    mcpUrl: previewUrl,
  },
  argTypes: { open: { control: false } },
  render: (args, context) => (
    <HostMcpPreview {...args} initiallyOpen={context.viewMode === "story"} />
  ),
};

export default meta;
type Story = StoryObj<typeof HostMcpDialog>;

export const Ready: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(within(dialog).getByLabelText("MCP URL")).toHaveValue(
      previewUrl,
    );
    await expect(within(dialog).getByLabelText("Cursor snippet")).toHaveValue(
      mcpClientSnippet(previewUrl),
    );
    await expect(args.onClose).not.toHaveBeenCalled();
  },
};

export const NoEpisode: Story = {
  args: { hasProject: false },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await waitFor(() =>
      expect(within(dialog).getByText(/Open an episode first/)).toBeVisible(),
    );
  },
};

export const Phone: Story = {
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await waitFor(() => expect(dialog).toBeVisible());
  },
};
