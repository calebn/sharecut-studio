import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  isolatedStoryParameters,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { playInCanvas } from "../../storybook/storyPlay";
import { SCRIPT_TURNS } from "../../system/scriptFixtures";
import { GuestReview } from "./GuestReview";
import { DURATION, PEAKS, PEOPLE, TICKS, WORD_STARTS } from "./guestFixture";

function Placeholder() {
  return (
    <div
      role="group"
      aria-label="Composer slot"
      style={{
        padding: "var(--space-4)",
        border: "1px dashed var(--color-border)",
        color: "var(--color-text-secondary)",
      }}
    >
      The Review lane&apos;s Composer goes here.
    </div>
  );
}

async function expectCoverFills(canvasElement: HTMLElement, least: number) {
  const body = canvasElement.querySelector(".gr-body")?.getBoundingClientRect();
  const cover = canvasElement
    .querySelector(".sys-cover")
    ?.getBoundingClientRect();
  // jsdom has no layout; only a real browser can see the Cover collapse.
  if (!body || !cover || body.width === 0) return;
  await expect(cover.width).toBeGreaterThan(body.width * least);
}

const phone = { viewport: { value: "mobile360", isRotated: false } };

const meta: Meta<typeof GuestReview> = {
  title: "Stages/Review/Guest",
  component: GuestReview,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div style={{ blockSize: "100dvh" }}>
        <Story />
      </div>
    ),
  ],
  args: {
    access: "commenter",
    title: "Field Notes 14",
    version: "Rough cut · 25 Oct",
    people: PEOPLE,
    turns: SCRIPT_TURNS,
    wordStarts: WORD_STARTS,
    duration: DURATION,
    peaks: PEAKS,
    ticks: TICKS,
    initialPlayhead: 735,
    composer: <Placeholder />,
    onComment: fn(),
    onRetry: fn(),
  },
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "Guest Review: what a link opens. Viewers and commenters get Review alone, with no Stage bar; editors get Edit and Review. The expanded Player sits on top, the Composer under it, then the read-only Script, which follows the playhead until the guest scrolls it away. The Composer's time chip follows the playhead until the first keystroke pins it; pressing the chip moves it to the playhead. On a phone the Player collapses to its bar when the Script scrolls and the Composer docks at the bottom. A dead link shows a Cover, never the server's answer. Presentational: nothing here talks to the server. The Composer is the Review lane's and drops into a slot. The Role chip explains itself once on a first visit. Offline shows the Save indicator's waiting count; the queue behind it is wired later.\n\n**Motion.** Animations come later: the Player's collapse uses `--motion-panel`, the Script's follow scroll `--motion-state`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof GuestReview>;

export const Commenter: Story = {
  play: playInCanvas(async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.queryByRole("tab", { name: /Edit/ })).toBeNull();
    await expect(
      view.getByRole("group", { name: "Composer slot" }),
    ).toBeVisible();
  }),
};

export const Viewer: Story = {
  args: { access: "viewer" },
  play: playInCanvas(async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      view.queryByRole("group", { name: "Composer slot" }),
    ).toBeNull();
    await expect(view.getByText("Welcome")).toBeInTheDocument();
  }),
};

export const Editor: Story = {
  tags: ["wide-only"],
  parameters: {
    wideOnlyReason:
      "The Edit and Review tabs sit in the desktop header; the phone form puts them in the tab bar (EditorPhone).",
  },
  args: { access: "editor" },
  play: playInCanvas(async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole("tab", { name: /Edit/ }));
    await expect(view.getByText("Edit opens here")).toBeInTheDocument();
    await expectCoverFills(canvasElement, 0.5);
    await userEvent.click(view.getByRole("tab", { name: /Review/ }));
    await expect(
      view.getByRole("group", { name: "Composer slot" }),
    ).toBeVisible();
  }),
};

export const Playing: Story = { args: { initialPlaying: true } };

export const Empty: Story = {
  args: { turns: [] },
  play: playInCanvas(async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Nothing to read yet"),
    ).toBeInTheDocument();
  }),
};

export const Loading: Story = { args: { state: "loading" } };

export const ErrorState: Story = {
  args: { state: "error" },
  play: playInCanvas(async ({ canvasElement, args }) => {
    await expectCoverFills(canvasElement, 0.5);
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Try again" }),
    );
    await expect(args.onRetry).toHaveBeenCalledOnce();
  }),
};

export const BadLink: Story = {
  args: { state: "bad-link" },
  play: playInCanvas(async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      view.getByRole("heading", { name: "This link doesn't open anything" }),
    ).toBeInTheDocument();
    await expect(view.queryByRole("button")).toBeNull();
  }),
};

function phoneStory(role: "viewer" | "commenter" | "editor"): Story {
  return {
    args: { access: role, layout: "phone" },
    parameters: isolatedStoryParameters,
    globals: phone,
  };
}

export const ViewerPhone: Story = phoneStory("viewer");
export const CommenterPhone: Story = phoneStory("commenter");
export const EditorPhone: Story = {
  ...phoneStory("editor"),
  play: playInCanvas(async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole("tab", { name: /Edit/ }));
    await expectCoverFills(canvasElement, 0.5);
  }),
};

export const BadLinkPhone: Story = {
  args: { state: "bad-link", layout: "phone" },
  parameters: isolatedStoryParameters,
  globals: phone,
};

export const FirstVisitRoleHint: Story = {
  args: { firstVisit: true, onRoleHintSeen: fn() },
  play: playInCanvas(async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByRole("note")).toHaveTextContent(
      "You can comment and suggest cuts. The host decides.",
    );
    await userEvent.click(view.getByRole("button", { name: "Dismiss hint" }));
    await expect(view.queryByRole("note")).toBeNull();
    await expect(args.onRoleHintSeen).toHaveBeenCalledOnce();
  }),
};

export const FirstVisitRoleHintPhone: Story = {
  args: { firstVisit: true, layout: "phone" },
  parameters: isolatedStoryParameters,
  globals: phone,
};

export const Offline: Story = {
  args: { save: { state: "offline", waiting: 2 } },
  play: playInCanvas(async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(/2 waiting/),
    ).toBeInTheDocument();
  }),
};

export const Reconnected: Story = {
  args: { save: { state: "saved", justSaved: true } },
};
