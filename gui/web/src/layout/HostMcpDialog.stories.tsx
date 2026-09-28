import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { expect, fn, waitFor, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { openDialogViaLauncher } from "../storybook/openDialog";
import { Button } from "../ui/Button";
import { HostMcpDialog } from "./HostMcpDialog";
import { mcpClientSnippet } from "./hostMcp";

const previewUrl = "http://127.0.0.1:8765/mcp";

function HostMcpPreview({
  initiallyOpen,
  ...args
}: ComponentProps<typeof HostMcpDialog> & { initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        Open agent connection
      </Button>
      <HostMcpDialog
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
    const dialog = await openDialogViaLauncher(
      canvasElement,
      "Open agent connection",
      "Connect agent",
    );
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
    const dialog = await openDialogViaLauncher(
      canvasElement,
      "Open agent connection",
      "Connect agent",
    );
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
    const dialog = await openDialogViaLauncher(
      canvasElement,
      "Open agent connection",
      "Connect agent",
    );
    await waitFor(() => expect(dialog).toBeVisible());
  },
};
