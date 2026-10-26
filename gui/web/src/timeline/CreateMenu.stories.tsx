import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { portaledOverlayParameters } from "../storybook/storyLayout";
import { MIRA } from "../test/episodeFixture";
import { hitRouterStub } from "../test/hitRouterStub";
import { episodeBeforeEach, withEpisode } from "../test/withEpisode";
import { CreateMenu, type CreateMenuPlace } from "./CreateMenu";

const place: CreateMenuPlace = {
  atTime: 24.5,
  trackId: MIRA,
  trackLabel: "Mira",
  lane: { top: 120, bottom: 200 },
  level: 1,
};

const meta: Meta<typeof CreateMenu> = {
  title: "Templates/CreateMenu",
  component: CreateMenu,
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  parameters: {
    ...portaledOverlayParameters,
    layout: "fullscreen",
    episode: {},
  },
  args: {
    view: {
      origin: { x: 220, y: 160 },
      surface: document.documentElement,
      fingerDown: false,
      over: null,
    },
    place,
    router: hitRouterStub(),
    bounds: { left: 0, top: 0, right: 1000, bottom: 600 },
    avoidX: null,
  },
};

export default meta;
type Story = StoryObj<typeof CreateMenu>;

export const OnLane: Story = {
  play: async () => {
    const menu = await within(document.body).findByRole("menu", {
      name: "Create at 00:24.500 · Mira",
    });
    await expect(
      within(menu).getByRole("menuitem", { name: /Add envelope point/ }),
    ).toBeVisible();
  },
};

export const EmptySpace: Story = {
  args: {
    place: { ...place, trackId: null, trackLabel: null, level: null },
  },
  play: async () => {
    const menu = await within(document.body).findByRole("menu");
    await expect(
      within(menu).getByRole("menuitem", { name: /Add envelope point/ }),
    ).toHaveAttribute("aria-disabled", "true");
  },
};

export const FingerOverItem: Story = {
  args: {
    view: {
      origin: { x: 220, y: 160 },
      surface: document.documentElement,
      fingerDown: true,
      over: 1,
    },
  },
};
