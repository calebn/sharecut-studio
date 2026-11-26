import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { expect, fireEvent, fn, waitFor, within } from "storybook/test";
import { recordMobileViewport } from "../../record/recordStoryDecorator";
import { openDialogViaLauncher } from "../../storybook/openDialog";
import { isolatedStoryParameters } from "../../storybook/storyLayout";
import { Button } from "../../ui/Button";
import { HostMcpDialog } from "./HostMcpDialog";
import {
  COPY_FAILED_MESSAGE,
  mcpClientSnippet,
  UNAVAILABLE_MESSAGE,
} from "./hostMcp";

const previewUrl = "http://127.0.0.1:8765/mcp";

/** An answer from the host, `seconds` after the last request. */
const usedAgo = (seconds: number) => ({
  mounted: true,
  last_request_at: "2026-01-01T00:00:00Z",
  age_seconds: seconds,
});

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
    activityPreview: {
      mounted: true,
      last_request_at: null,
      age_seconds: null,
    },
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
    await expect(
      within(dialog).getByLabelText("Connection address"),
    ).toHaveValue(previewUrl);
    await expect(
      within(dialog).getByLabelText("Configuration (JSON)"),
    ).toHaveValue(mcpClientSnippet(previewUrl));
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
      const copyUrl = within(dialog).getByRole("button", {
        name: "Copy address",
      });
      await waitFor(() => expect(copyUrl).toHaveFocus());
      await fireEvent.click(copyUrl);
      await waitFor(() =>
        expect(
          within(dialog).getByRole("button", { name: "Copied" }),
        ).toBeVisible(),
      );
      await expect(within(dialog).getByText("Copied address")).toBeVisible();
      await waitFor(
        async () => {
          await expect(within(dialog).queryByText("Copied address")).toBeNull();
          await expect(
            within(dialog).getByRole("button", { name: "Copy address" }),
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
        within(dialog).getByRole("button", { name: "Copy config" }),
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

async function openDialog(canvasElement: HTMLElement) {
  const dialog = await openDialogViaLauncher(
    canvasElement,
    "Open agent connection",
    "Connect agent",
  );
  await waitFor(() => expect(dialog).toBeVisible());
  return dialog;
}

export const NeverUsed: Story = {
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await waitFor(() =>
      expect(
        within(dialog).getByText(
          "No app has used this address since Studio started.",
        ),
      ).toBeVisible(),
    );
  },
};

export const UsedJustNow: Story = {
  args: { activityPreview: usedAgo(4) },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await waitFor(() =>
      expect(
        within(dialog).getByText("An app used this address just now."),
      ).toBeVisible(),
    );
  },
};

export const UsedMinutesAgo: Story = {
  args: { activityPreview: usedAgo(185) },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await waitFor(() =>
      expect(
        within(dialog).getByText("An app used this address 3 minutes ago."),
      ).toBeVisible(),
    );
  },
};

export const LastUsedHoursAgo: Story = {
  args: { activityPreview: usedAgo(3 * 3600 + 40) },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await waitFor(() =>
      expect(within(dialog).getByText("Last used 3 hours ago.")).toBeVisible(),
    );
  },
};

export const Unavailable: Story = {
  args: {
    activityPreview: {
      mounted: false,
      last_request_at: null,
      age_seconds: null,
    },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await waitFor(() =>
      expect(within(dialog).getByText(UNAVAILABLE_MESSAGE)).toBeVisible(),
    );
    await expect(
      within(dialog).queryByRole("button", { name: "Copy address" }),
    ).toBeNull();
    await expect(
      within(dialog).getByRole("link", { name: /Setup guide/ }),
    ).toBeVisible();
  },
};

export const ConfigOpen: Story = {
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    const summary = within(dialog).getByText("Config file format");
    await expect(
      within(dialog).getByLabelText("Configuration (JSON)"),
    ).not.toBeVisible();
    await fireEvent.click(summary);
    await waitFor(() =>
      expect(
        within(dialog).getByLabelText("Configuration (JSON)"),
      ).toBeVisible(),
    );
  },
};

export const PhoneConfigOpen: Story = {
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await fireEvent.click(within(dialog).getByText("Config file format"));
    await waitFor(() =>
      expect(
        within(dialog).getByLabelText("Configuration (JSON)"),
      ).toBeVisible(),
    );
  },
};
