import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { disambiguatedNames } from "../../presence/colors";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { sessionClient } from "../../test/fixtures";
import { AvatarStackView } from "./AvatarStackView";
import type { PresenceViewer } from "./personCard";

const SELF = sessionClient({
  client_id: "story-self",
  followers: 2,
  meta: { display_name: "You", color_index: 0 },
});
const ROSA = sessionClient({
  client_id: "rosa",
  meta: {
    display_name: "Rosa",
    color_index: 1,
    ui: { tab: "impact" },
    transport: { playhead_sec: 1394, playing: false, rate: 1 },
  },
});
const MAYA = sessionClient({
  client_id: "maya",
  meta: {
    display_name: "Maya",
    color_index: 2,
    ui: { tab: "transcript" },
    transport: { playhead_sec: 312, playing: false, rate: 1 },
  },
});
const BO = sessionClient({
  client_id: "bo",
  role: "agent",
  meta: { display_name: "Bo", color_index: 3, ui: { tab: "pipeline" } },
});
const CY = sessionClient({
  client_id: "cy",
  meta: { display_name: "Cy", color_index: 4, following: "rosa" },
});
const DI = sessionClient({
  client_id: "di",
  meta: { display_name: "Di", color_index: 5 },
});

const NAMES = disambiguatedNames([SELF, ROSA, MAYA, BO, CY, DI]);

const VIEWER: PresenceViewer = {
  stage: "edit",
  durationSec: 3600,
  caps: { guestShare: false, breakpoint: "desktop", role: "host" },
};

const WIDE_ONLY_REASON =
  "Desktop header: faces fold into the Stage menu below 40rem; FollowingPhone covers the phone.";

const meta: Meta<typeof AvatarStackView> = {
  title: "Stages/Frame/Presence",
  component: AvatarStackView,
  tags: ["autodocs"],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The header's people. Up to three 24 px faces with a 2 px ring in the person's colour and a 12 px badge for the stage they are in when it is not yours; a count for the rest. A face opens a menu with their name, role and where they are, Follow and Go to where they are (absent when this link cannot open that stage). Following thickens the ring to 3 px and adds a 32 px pill, Following Rosa with a stop button; the phone keeps one face, a count, and the pill's glyph and stop button.",
      },
    },
  },
  decorators: [
    (Story, context) => (
      <div
        className="sys-app-header-host"
        style={{ maxInlineSize: context.parameters.headerWidth ?? "56rem" }}
      >
        <div className="sys-header-right">
          <Story />
        </div>
      </div>
    ),
  ],
  args: {
    self: SELF,
    names: NAMES,
    followingClientId: null,
    viewer: VIEWER,
    onFollow: fn(),
    onUnfollow: fn(),
    onGoTo: fn(),
  },
};
export default meta;

type Story = StoryObj<typeof meta>;

export const Solo: Story = {
  args: { others: [], self: undefined },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".avatar-header")).toBeNull();
  },
};

export const Avatars: Story = {
  tags: ["wide-only"],
  parameters: { wideOnlyReason: WIDE_ONLY_REASON },
  args: { others: [ROSA, MAYA, BO] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rosa = canvas.getByRole("button", { name: "Rosa, Review, 23:14" });
    await expect(rosa.querySelector(".avatar-face-badge")).not.toBeNull();
    await expect(
      canvas
        .getByRole("button", { name: "Maya, Edit, 5:12" })
        .querySelector(".avatar-face-badge"),
    ).toBeNull();
    await expect(canvas.getByLabelText("2 following you")).toBeVisible();
  },
};

export const Overflow: Story = {
  tags: ["wide-only"],
  parameters: { wideOnlyReason: WIDE_ONLY_REASON },
  args: { others: [ROSA, MAYA, BO, CY, DI] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "+2 more" }));
    const body = within(document.body);
    await expect(await body.findByRole("group", { name: "Di" })).toBeVisible();
    await expect(
      body.getByRole("group", { name: "Cy, Following Rosa" }),
    ).toBeVisible();
  },
};

export const Popover: Story = {
  tags: ["wide-only"],
  parameters: { wideOnlyReason: WIDE_ONLY_REASON },
  args: { others: [ROSA, MAYA] },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Rosa, Review, 23:14" }),
    );
    const body = within(document.body);
    const menu = await body.findByRole("menu", { name: "Rosa, Review, 23:14" });
    await expect(menu).toHaveTextContent("Viewer · Review · 23:14");
    await userEvent.click(
      body.getByRole("menuitem", { name: "Go to where they are" }),
    );
    await expect(args.onGoTo).toHaveBeenCalledWith("rosa");
    await waitFor(() => expect(body.queryByRole("menu")).toBeNull());
    await userEvent.click(
      canvas.getByRole("button", { name: "Rosa, Review, 23:14" }),
    );
    await userEvent.click(
      await body.findByRole("menuitem", { name: "Follow" }),
    );
    await expect(args.onFollow).toHaveBeenCalledWith("rosa");
  },
};

export const GuestPopover: Story = {
  tags: ["wide-only"],
  parameters: { wideOnlyReason: WIDE_ONLY_REASON },
  args: {
    others: [BO],
    viewer: {
      stage: "review",
      durationSec: 3600,
      caps: { guestShare: true, breakpoint: "desktop", role: "viewer" },
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: /^Bo/ }),
    );
    const body = within(document.body);
    await expect(
      await body.findByRole("menuitem", { name: "Follow" }),
    ).toBeVisible();
    await expect(body.queryByRole("menuitem", { name: /Go to/ })).toBeNull();
  },
};

export const Following: Story = {
  tags: ["wide-only"],
  parameters: { wideOnlyReason: WIDE_ONLY_REASON },
  args: { others: [ROSA, MAYA], followingClientId: "rosa" },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: /^Rosa/ })).toHaveAttribute(
      "data-following",
    );
    await expect(canvas.getByText("Following Rosa")).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Stop following Rosa" }),
    );
    await expect(args.onUnfollow).toHaveBeenCalledTimes(1);
  },
};

export const FollowingPhone: Story = {
  parameters: {
    headerWidth: "22rem",
    viewport: { defaultViewport: "mobile390" },
  },
  args: { others: [ROSA, MAYA, BO], followingClientId: "rosa" },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Rosa, Review, 23:14" }),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "+2 more" })).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Stop following Rosa" }),
    );
    await expect(args.onUnfollow).toHaveBeenCalledTimes(1);
  },
};

export const PeopleMenu: Story = {
  decorators: [
    (Story) => (
      <div role="menu" aria-label="People" className="ui-menu-panel">
        <Story />
      </div>
    ),
  ],
  args: { variant: "menu", others: [ROSA, MAYA] },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const rosa = within(canvas.getByRole("group", { name: /^Rosa/ }));
    await userEvent.click(rosa.getByRole("menuitem", { name: "Follow" }));
    await expect(args.onFollow).toHaveBeenCalledWith("rosa");
    await expect(
      rosa.getByRole("menuitem", { name: "Go to where they are" }),
    ).toBeVisible();
  },
};
