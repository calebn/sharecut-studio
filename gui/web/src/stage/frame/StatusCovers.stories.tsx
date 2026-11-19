import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { GuestLoadFailure } from "../../guestLoadFailure";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { GuestPageCover, NotServedCover } from "./StatusCovers";

/** A review-link cover whose button runs a pretend attempt that fails again after 300 ms. */
function ReviewLinkCover({ failure }: { failure: GuestLoadFailure }) {
  const [trying, setTrying] = useState(false);
  return (
    <GuestPageCover
      failure={failure}
      trying={trying}
      onRetry={() => {
        setTrying(true);
        window.setTimeout(() => setTrying(false), 300);
      }}
    />
  );
}

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
          'The Status cover for the ways a page has nothing to open: a bad or revoked review link, a review link that did not load (the host\'s computer is asleep or busy, this device has no connection, the link is busy, restricted, unavailable, needing a sign-in, behind a network sign-in page, or failing), and a project this server does not serve. A press on the button is answered on the button ("Trying…") and in a status line that says whether it is still failing. A 32 px symbol, a 48 px glyph for the case (broken link, moon, cloud with a slash, folder), a 20/24 title, one sentence, one primary button and at most one text button. The server answers the not-served case with the app (HTTP 403), never its own page.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof NotServedCover>;

export const BadLink: Story = {
  render: () => (
    <GuestPageCover
      failure={{ kind: "bad-link" }}
      trying={false}
      onRetry={fn()}
    />
  ),
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

const LONG_TEXT = "A long thought about the second act. ".repeat(140);

export const BadLinkWithUnsentComment: Story = {
  render: () => (
    <GuestPageCover
      failure={{ kind: "bad-link" }}
      trying={false}
      onRetry={fn()}
      unsent={[{ label: "Your comment", text: "Cut the pause at 1:05." }]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "This link doesn't open anything" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("textbox", { name: "Your comment was not posted" }),
    ).toHaveValue("Cut the pause at 1:05.");
    await expect(
      canvas.getByRole("button", { name: "Copy your comment" }),
    ).toBeVisible();
  },
};

export const BadLinkWithUnsentRtlComment: Story = {
  render: () => (
    <GuestPageCover
      failure={{ kind: "bad-link" }}
      trying={false}
      onRetry={fn()}
      unsent={[{ label: "Your comment", text: "לחתוך את ההפסקה בדקה 1:05" }]}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("textbox", {
        name: "Your comment was not posted",
      }),
    ).toHaveAttribute("dir", "auto");
  },
};

export const BadLinkWithSeveralUnsentTexts: Story = {
  render: () => (
    <GuestPageCover
      failure={{ kind: "bad-link" }}
      trying={false}
      onRetry={fn()}
      unsent={[
        { label: "Your comment", text: "Cut the pause at 1:05." },
        { label: "Your reply", text: "Agreed, trim it." },
        { label: "Your note", text: "Please keep the laugh." },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("textbox", { name: "These were not posted" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Copy all" }),
    ).toBeVisible();
  },
};

export const BadLinkWithVeryLongUnsentText: Story = {
  render: () => (
    <GuestPageCover
      failure={{ kind: "bad-link" }}
      trying={false}
      onRetry={fn()}
      unsent={[{ label: "Your comment", text: LONG_TEXT }]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Copy your comment" }),
    ).toBeVisible();
  },
};

export const HostAsleep: Story = {
  render: () => <ReviewLinkCover failure={{ kind: "unreachable" }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "The host's computer is asleep" }),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Try now" })).toBeVisible();
  },
};

export const HostAsleepPressed: Story = {
  render: () => <ReviewLinkCover failure={{ kind: "unreachable" }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", { name: "Try now" });
    await userEvent.click(button);
    await expect(button).toHaveAttribute("aria-busy", "true");
    await expect(canvas.getByRole("status")).toHaveTextContent("Trying again…");
    await waitFor(() =>
      expect(canvas.getByRole("status")).toHaveTextContent("Still asleep."),
    );
    await expect(button).toHaveFocus();
  },
};

export const YouAreOffline: Story = {
  render: () => <ReviewLinkCover failure={{ kind: "offline" }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "You're offline" }),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Try now" })).toBeVisible();
  },
};

export const YouAreOfflinePressed: Story = {
  render: () => <ReviewLinkCover failure={{ kind: "offline" }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", { name: "Try now" });
    await userEvent.click(button);
    await expect(button).toHaveAttribute("aria-busy", "true");
    await waitFor(() =>
      expect(canvas.getByRole("status")).toHaveTextContent("Still offline."),
    );
    await expect(button).toHaveFocus();
  },
};

export const HostBusy: Story = {
  render: () => <ReviewLinkCover failure={{ kind: "busy" }} />,
};

export const LinkBusy: Story = {
  render: () => (
    <ReviewLinkCover failure={{ kind: "rate-limited", retryAfterSec: 30 }} />
  ),
};

export const LinkRestricted: Story = {
  render: () => <ReviewLinkCover failure={{ kind: "restricted" }} />,
};

export const SignInRequired: Story = {
  render: () => <ReviewLinkCover failure={{ kind: "sign-in" }} />,
};

export const LinkUnavailable: Story = {
  render: () => <ReviewLinkCover failure={{ kind: "unavailable" }} />,
};

export const NetworkInTheWay: Story = {
  render: () => <ReviewLinkCover failure={{ kind: "intercepted" }} />,
};

export const ServerFailure: Story = {
  render: () => <ReviewLinkCover failure={{ kind: "server" }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(canvas.getByRole("status")).toHaveTextContent(
        "Still not loading.",
      ),
    );
  },
};

export const NoReviewRoutes: Story = {
  render: () => <ReviewLinkCover failure={{ kind: "no-review-routes" }} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("button")).toBeNull();
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
