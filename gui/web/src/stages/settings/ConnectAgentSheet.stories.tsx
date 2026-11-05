import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { isolatedStoryParameters } from "../../storybook/storyLayout";
import { ConnectAgentSheet } from "./ConnectAgentSheet";

const meta: Meta<typeof ConnectAgentSheet> = {
  title: "Stages/Settings/ConnectAgent",
  component: ConnectAgentSheet,
  tags: ["autodocs"],
  args: {
    form: "centered",
    open: true,
    url: "http://127.0.0.1:8765/mcp",
    hasProject: true,
    connected: null,
    onClose: fn(),
    onCopy: fn(async () => undefined),
    onOpenRecent: fn(),
  },
  parameters: {
    ...isolatedStoryParameters,
    docs: {
      ...isolatedStoryParameters.docs,
      description: {
        component:
          "Connect agent: a segmented control picks the client (Claude, Cursor, Other). One read-only block shows exactly what to paste for it, the URL for Claude and Other and the JSON config for Cursor, with one primary Copy. Under it a status line follows presence: Not connected yet turns to Connected, with the agent's name, when an agent joins. With no episode open it says to open one and links to Recent. A centred card on desktop, a bottom sheet on a phone. The story passes a fixed loopback URL so the preview does not depend on Storybook's port.\n\n**Motion.** None.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ConnectAgentSheet>;

const dialog = () =>
  within(document.body).findByRole("dialog", { name: "Connect agent" });

export const Claude: Story = {
  play: async ({ args, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = within(await dialog());
    await expect(sheet.getByLabelText("MCP URL")).toHaveValue(args.url);
    await expect(sheet.getByText("Not connected yet")).toBeVisible();
    await userEvent.click(sheet.getByRole("button", { name: "Copy" }));
    await expect(args.onCopy).toHaveBeenCalledWith(args.url);
  },
};

export const Cursor: Story = {
  args: { defaultClient: "cursor" },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = within(await dialog());
    const config = sheet.getByLabelText("Cursor config") as HTMLTextAreaElement;
    await expect(JSON.parse(config.value)).toEqual({
      mcpServers: { sharecut: { url: "http://127.0.0.1:8765/mcp" } },
    });
    await userEvent.click(sheet.getByRole("button", { name: "Other" }));
    await expect(sheet.getByLabelText("MCP URL")).toBeVisible();
  },
};

export const Connected: Story = {
  args: { connected: "Claude" },
  play: async ({ viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = within(await dialog());
    await expect(sheet.getByText("Connected: Claude")).toBeVisible();
  },
};

export const NoEpisode: Story = {
  args: { hasProject: false },
  play: async ({ args, viewMode }) => {
    if (viewMode === "docs") return;
    const sheet = within(await dialog());
    await expect(
      sheet.getByText(
        /Open an episode first. The agent works on the open episode./,
      ),
    ).toBeVisible();
    await userEvent.click(sheet.getByRole("button", { name: "Recent" }));
    await expect(args.onOpenRecent).toHaveBeenCalled();
  },
};

export const Phone: Story = {
  args: { form: "bottom", connected: "Claude" },
  globals: { viewport: { value: "mobile390", isRotated: false } },
};
