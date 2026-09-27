import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { dawShellStoryDecorator } from "./dawShellStoryDecorator";
import { FollowBannerView } from "./FollowBannerView";

const meta: Meta<typeof FollowBannerView> = {
  title: "Templates/FollowBanner",
  component: FollowBannerView,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [dawShellStoryDecorator],
  args: {
    name: "Mira",
    colorIndex: 2,
    sessionRole: "viewer",
    guest: false,
    degraded: {},
    onStopFollowing: fn(),
  },
};
export default meta;
type Story = StoryObj<typeof FollowBannerView>;

export const Following: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Following Mira")).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Stop following" }),
    );
    await expect(args.onStopFollowing).toHaveBeenCalledTimes(1);
  },
};

export const AgentLeader: Story = {
  args: { name: "Edit agent", sessionRole: "agent" },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(".ui-avatar svg"),
    ).toBeInTheDocument();
  },
};

export const GuestHostOnlyTab: Story = {
  args: { guest: true, degraded: { tab: "pipeline", audition: "fx" } },
  play: async ({ canvasElement }) => {
    const text = canvasElement.querySelector(
      ".follow-banner-text",
    )?.textContent;
    await expect(text).toContain("in Pipeline (host-only)");
    await expect(text).toContain("auditioning FX");
    await expect(text).toContain("Listening in Mix");
  },
};

export const HostMirrorsAudition: Story = {
  args: { guest: false, degraded: { audition: "raw" } },
  play: async ({ canvasElement }) => {
    const text = canvasElement.querySelector(
      ".follow-banner-text",
    )?.textContent;
    await expect(text).toContain("auditioning RAW");
    await expect(text).not.toContain("Listening in Mix");
  },
};

export const PhoneLongName: Story = {
  parameters: { ...recordMobileViewport.parameters, dawShellPhone: true },
  globals: recordMobileViewport.globals,
  args: { name: "Ada Lovelace Very Long Name" },
  play: async ({ canvasElement }) => {
    const shell = canvasElement.querySelector<HTMLElement>(".daw-shell");
    const text = canvasElement.querySelector<HTMLElement>(
      ".follow-banner-text",
    );
    const stop = within(canvasElement).getByRole("button", {
      name: "Stop following",
    });
    await expect(shell).toBeInTheDocument();
    await expect(text).toBeInTheDocument();
    if (!shell || !text) return;
    // jsdom (src/test/allStories.test.tsx) has no layout engine, so the
    // truncation and fit checks only run in a real Storybook browser.
    const shellRect = shell.getBoundingClientRect();
    if (shellRect.width === 0) return;
    // The long name truncates (ellipsis) instead of widening the banner…
    await expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
    // …so Stop following stays inside the 360px shell.
    await expect(stop.getBoundingClientRect().right).toBeLessThanOrEqual(
      shellRect.right,
    );
  },
};
