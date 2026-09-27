import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { HostMcpDialog } from "./HostMcpDialog";
import { mcpClientSnippet } from "./hostMcp";

const previewUrl = "http://127.0.0.1:8765/mcp";

const meta: Meta<typeof HostMcpDialog> = {
  title: "Templates/HostMcpDialog",
  component: HostMcpDialog,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onClose: fn(),
    hasProject: true,
    mcpUrl: previewUrl,
  },
  decorators: [
    (Story) => (
      <main aria-label="Studio backdrop">
        <Story />
      </main>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof HostMcpDialog>;

export const Ready: Story = {
  play: async () => {
    const dialog = within(document.body).getByRole("dialog", {
      name: "Connect agent",
    });
    await expect(within(dialog).getByLabelText("MCP URL")).toHaveValue(
      previewUrl,
    );
    await expect(within(dialog).getByLabelText("Cursor snippet")).toHaveValue(
      mcpClientSnippet(previewUrl),
    );
  },
};

export const NoEpisode: Story = {
  args: { hasProject: false },
  play: async () => {
    const dialog = within(document.body).getByRole("dialog", {
      name: "Connect agent",
    });
    await expect(
      within(dialog).getByText(/Open an episode first/),
    ).toBeVisible();
  },
};

export const Phone: Story = {
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
};
