import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import {
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { episodeBeforeEach, withEpisode } from "../test/withEpisode";
import { TransportBar } from "./TransportBar";

const meta: Meta<typeof TransportBar> = {
  title: "Templates/Transport menus",
  component: TransportBar,
  beforeEach: episodeBeforeEach,
  decorators: [
    withEpisode,
    (Story) => (
      <div
        className="daw-shell"
        style={{ blockSize: "34rem", inlineSize: "100%" }}
      >
        <Story />
        <main aria-label="Stage" />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    episode: {},
  },
  args: { showLayout: true },
};

export default meta;
type Story = StoryObj<typeof TransportBar>;

const openMenu = async (canvasElement: HTMLElement) => {
  await userEvent.click(
    await within(canvasElement).findByRole("button", { name: /^Menu$/ }),
  );
  return within(document.body).findByRole("menu", {
    name: "Transport menu",
  });
};

export const MainMenu: Story = {
  play: async ({ canvasElement }) => {
    const menu = await openMenu(canvasElement);
    await expect(within(menu).getByText("Project")).toBeVisible();
    await expect(
      within(menu).getByRole("menuitem", { name: /^Share…/ }),
    ).toBeVisible();
  },
};

export const MainMenuGuest: Story = {
  args: { compact: true },
  parameters: { episode: { role: "commenter" } },
  play: async ({ canvasElement }) => {
    const menu = await openMenu(canvasElement);
    await expect(within(menu).queryByText("Project")).toBeNull();
    await expect(within(menu).getByText("Theme")).toBeVisible();
  },
};

export const MainMenuCollapsed: Story = {
  args: { compact: true },
  play: async ({ canvasElement }) => {
    const menu = await openMenu(canvasElement);
    await expect(within(menu).getByText("Layers")).toBeVisible();
  },
};

export const WideBar: Story = {
  tags: ["wide-only"],
  parameters: {
    wideOnlyReason:
      "The story draws the bar in an 80rem frame, so the page overflows a 360 px viewport.",
  },
  decorators: [
    (Story) => (
      <div style={{ inlineSize: "80rem" }}>
        <Story />
      </div>
    ),
  ],
};
