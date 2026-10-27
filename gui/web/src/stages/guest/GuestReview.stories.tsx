import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  isolatedStoryParameters,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { playInCanvas } from "../../storybook/storyPlay";
import { type QueuedComment, saveOf } from "./commentQueue";
import { GuestReview } from "./GuestReview";
import {
  DURATION,
  PEAKS,
  PEOPLE,
  SCRIPT_TURNS,
  TICKS,
  WORD_STARTS,
} from "./guestFixture";

function Placeholder() {
  return (
    <div className="gr-composer" role="group" aria-label="Composer slot">
      The Review lane&apos;s Composer goes here.
    </div>
  );
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
          "Guest Review: what a link opens. Viewers and commenters get Review alone, with no Stage bar; editors get Edit and Review. The expanded Player sits on top, the Composer under it, then the read-only Script, which follows the playhead until the guest scrolls it away. The Composer's time chip follows the playhead until the first keystroke pins it; pressing the chip moves it to the playhead. On a phone the Player collapses to its bar when the Script scrolls and the Composer docks at the bottom. A dead link shows a Cover, never the server's answer. Presentational: nothing here talks to the server. The Composer is the Review lane's and drops into a slot. The Role chip's one-time hint and the offline queue come in the next slice.\n\n**Motion.** Animations come later: the Player's collapse uses `--motion-panel`, the Script's follow scroll `--motion-state`.",
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
  args: { access: "editor" },
  play: playInCanvas(async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole("tab", { name: /Edit/ }));
    await expect(view.getByText("Edit opens here")).toBeInTheDocument();
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
export const EditorPhone: Story = phoneStory("editor");

export const CommenterPhone390: Story = {
  args: { layout: "phone" },
  parameters: isolatedStoryParameters,
  decorators: [
    (Story) => (
      <div style={{ inlineSize: "390px", blockSize: "100dvh" }}>
        <Story />
      </div>
    ),
  ],
};

export const BadLinkPhone: Story = {
  args: { state: "bad-link", layout: "phone" },
  parameters: isolatedStoryParameters,
  globals: phone,
};

const waiting = (status: QueuedComment["status"], count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: String(i),
    body: "Cut this",
    at: 735,
    name: "Guest",
    status,
  }));

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
  args: { save: saveOf([], false) },
};

export const OfflineQueued: Story = {
  args: { save: saveOf(waiting("queued", 2), false) },
  play: playInCanvas(async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(/2 waiting/),
    ).toBeInTheDocument();
  }),
};

export const Reconnected: Story = {
  args: { save: { ...saveOf(waiting("sent", 2), true), justSaved: true } },
};
