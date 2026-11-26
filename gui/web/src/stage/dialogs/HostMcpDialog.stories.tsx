import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { expect, fireEvent, fn, waitFor, within } from "storybook/test";
import { recordMobileViewport } from "../../record/recordStoryDecorator";
import { openDialogViaLauncher } from "../../storybook/openDialog";
import { isolatedStoryParameters } from "../../storybook/storyLayout";
import { Button } from "../../ui/Button";
import { HostMcpDialog } from "./HostMcpDialog";
import { COPY_FAILED_MESSAGE, mcpClientSnippet } from "./hostMcp";

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
  parameters: { ...isolatedStoryParameters, layout: "padded" },
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

/** Swap the clipboard for the story (click with fireEvent: userEvent installs its own); the returned function puts the original back. */
function stubClipboard(writeText: () => Promise<void>): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return () => {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  };
}

export const Copied: Story = {
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const restore = stubClipboard(() => Promise.resolve());
    try {
      const dialog = await openDialogViaLauncher(
        canvasElement,
        "Open agent connection",
        "Connect agent",
      );
      await waitFor(() => expect(dialog).toBeVisible());
      const copyUrl = within(dialog).getByRole("button", { name: "Copy URL" });
      await waitFor(() => expect(copyUrl).toHaveFocus());
      await fireEvent.click(copyUrl);
      await waitFor(() =>
        expect(
          within(dialog).getByRole("button", { name: "Copied" }),
        ).toBeVisible(),
      );
      await expect(within(dialog).getByText("Copied MCP URL")).toBeVisible();
      await waitFor(
        async () => {
          await expect(within(dialog).queryByText("Copied MCP URL")).toBeNull();
          await expect(
            within(dialog).getByRole("button", { name: "Copy URL" }),
          ).toBeVisible();
        },
        { timeout: 3000 },
      );
    } finally {
      restore();
    }
  },
};

export const CopyFailed: Story = {
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const restore = stubClipboard(() =>
      Promise.reject(new DOMException("denied", "NotAllowedError")),
    );
    try {
      const dialog = await openDialogViaLauncher(
        canvasElement,
        "Open agent connection",
        "Connect agent",
      );
      await waitFor(() => expect(dialog).toBeVisible());
      await fireEvent.click(
        within(dialog).getByRole("button", { name: "Copy snippet" }),
      );
      await waitFor(() =>
        expect(within(dialog).getByText(COPY_FAILED_MESSAGE)).toBeVisible(),
      );
      await expect(within(dialog).queryByText(/denied/)).toBeNull();
    } finally {
      restore();
    }
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
