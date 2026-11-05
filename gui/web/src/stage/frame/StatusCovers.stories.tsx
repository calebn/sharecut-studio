import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { BadLinkCover, HostCover, NotServedCover } from "./StatusCovers";

const meta: Meta<typeof NotServedCover> = {
  title: "Stages/Frame/StatusCover",
  component: NotServedCover,
  tags: ["autodocs"],
  args: {
    notServed: {
      name: "Rosa and Maya",
      openHref: "/?project=%2Fep%2Fepisode.sharecut",
      homeHref: "/?home=1",
    },
    onNavigate: fn(),
  },
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The Status cover for the three ways a page has nothing to open: a bad or revoked review link, a host whose computer is asleep, and a project this server does not serve. A 32 px symbol, a 48 px glyph for the case (broken link, moon, folder), a 20/24 title, one sentence, one primary button and at most one text button. The server answers the not-served case with the app (HTTP 403), never its own page.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof NotServedCover>;

export const BadLink: Story = {
  render: () => <BadLinkCover />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "This link doesn't open anything" }),
    ).toBeVisible();
    await expect(
      canvas.getByText("Ask the person who sent it for a new link."),
    ).toBeVisible();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const HostAsleep: Story = {
  render: () => <HostCover asleep onRetry={fn()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "The host's computer is asleep" }),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Try now" })).toBeVisible();
  },
};

export const NotServed: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", {
        name: "This episode isn't open on this computer",
      }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Open Rosa and Maya" }),
    );
    await expect(args.onNavigate).toHaveBeenLastCalledWith(
      "/?project=%2Fep%2Fepisode.sharecut",
    );
    await userEvent.click(canvas.getByRole("button", { name: "All projects" }));
    await expect(args.onNavigate).toHaveBeenLastCalledWith("/?home=1");
  },
};

export const Phone: Story = {
  globals: { viewport: { value: "phone", isRotated: false } },
};
