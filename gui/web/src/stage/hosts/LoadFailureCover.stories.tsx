import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { HostLoadKind, ShellGuestFailure } from "../../shellLoadFailure";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { LoadFailureCover } from "./HostBody";
import type { LoadFailure } from "./hostModels";

type ShellFailure = Extract<LoadFailure, { source: "shell" }>;

const host = (kind: HostLoadKind, extra: Partial<ShellFailure> = {}) =>
  ({
    source: "shell",
    cause: { audience: "host", kind },
    name: "Rosa and Maya",
    onRetry: fn(),
    onHome: fn(),
    ...extra,
  }) satisfies LoadFailure;

const guest = (failure: ShellGuestFailure, extra: Partial<ShellFailure> = {}) =>
  ({
    source: "shell",
    cause: { audience: "guest", failure },
    name: "",
    onRetry: fn(),
    ...extra,
  }) satisfies LoadFailure;

const meta: Meta<typeof LoadFailureCover> = {
  title: "Stages/Frame/LoadFailureCover",
  component: LoadFailureCover,
  tags: ["autodocs"],
  args: { stage: "edit" },
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The Status cover at region size for the studio's first read of the episode failing after the studio has opened. One fixed sentence per kind of failure, never the server's words: a guest reads the review-link covers' sentences for the same cause, a host a sentence for an episode that can't be found, can't be read, is in use, is open elsewhere, isn't answering, was saved by a newer version, is in a format this version doesn't read or couldn't be opened. A press on Try again is answered on the button and in a status line; the sentence does not change.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof LoadFailureCover>;

const title = (name: string) => ({
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await expect(
      await within(canvasElement).findByRole("heading", { name }),
    ).toBeVisible();
  },
});

export const GuestAsleep: Story = {
  args: { failure: guest({ kind: "unreachable" }) },
  ...title("The host's computer is asleep"),
};
export const GuestOffline: Story = {
  args: { failure: guest({ kind: "offline" }) },
  ...title("You're offline"),
};
export const GuestBusy: Story = {
  args: { failure: guest({ kind: "busy" }) },
  ...title("Could not load the project"),
};
export const GuestRateLimited: Story = {
  args: { failure: guest({ kind: "rate-limited", retryAfterSec: 60 }) },
  ...title("Could not load the project"),
};
export const GuestSignIn: Story = {
  args: { failure: guest({ kind: "sign-in" }) },
  ...title("Could not load the project"),
};
export const GuestRestricted: Story = {
  args: { failure: guest({ kind: "restricted" }) },
  ...title("Could not load the project"),
};
export const GuestUnavailable: Story = {
  args: { failure: guest({ kind: "unavailable" }) },
  ...title("Could not load the project"),
};
export const GuestIntercepted: Story = {
  args: { failure: guest({ kind: "intercepted" }) },
  ...title("Could not load the project"),
};
export const GuestDoubt: Story = {
  args: { failure: guest({ kind: "doubt" }) },
  ...title("Could not load the project"),
};
export const GuestServer: Story = {
  args: { stage: "review", failure: guest({ kind: "server" }) },
  ...title("The transcript didn't load"),
};

export const GuestRetrying: Story = {
  args: { failure: guest({ kind: "unreachable" }, { trying: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Try now" }),
    );
    await expect(
      await canvas.findByRole("button", { name: "Trying…" }),
    ).toHaveAttribute("aria-busy", "true");
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      "Trying again…",
    );
  },
};

export const HostMissing: Story = {
  args: { failure: host("missing") },
  ...title("Could not load the project"),
};
export const HostDamaged: Story = {
  args: { failure: host("damaged") },
  ...title("Could not load the project"),
};
export const HostBusy: Story = {
  args: { failure: host("busy") },
  ...title("Could not load the project"),
};
export const HostElsewhere: Story = {
  args: { failure: host("elsewhere") },
  ...title("This episode isn't open on this computer"),
};
export const HostNotAnswering: Story = {
  args: { failure: host("not-answering") },
  ...title("Could not load the project"),
};
export const HostNewer: Story = {
  args: { failure: host("newer") },
  ...title("Could not load the project"),
};
export const HostUnsupported: Story = {
  args: { failure: host("unsupported") },
  ...title("Could not load the project"),
};
export const HostOther: Story = {
  args: { stage: "review", failure: host("other") },
  ...title("The transcript didn't load"),
};

export const HostRetrying: Story = {
  args: { failure: host("not-answering", { trying: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Try again" }),
    );
    await expect(
      await canvas.findByRole("button", { name: "Trying…" }),
    ).toHaveAttribute("aria-busy", "true");
  },
};

/** The transcript's own refresh: fixed words, no status line. */
export const TranscriptDetail: Story = {
  args: {
    stage: "review",
    failure: { source: "detail", onRetry: fn() },
  },
  ...title("The transcript didn't load"),
};
