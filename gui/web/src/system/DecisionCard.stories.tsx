import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fireEvent, fn, userEvent, within } from "storybook/test";
import {
  FILLER_EXCERPT,
  FILLER_WAVEFORM,
  FILLER_WITH_UNSURE,
  fillerPeaks,
  pausePeaks,
  UNSURE_EXCERPT,
} from "../storybook/reviewFixtures";
import { viewportStoryParameters } from "../storybook/storyLayout";
import type { AuditionSide } from "./auditionWindow";
import { DecisionCard, type DecisionCardProps } from "./DecisionCard";
import { Suggestion } from "./Suggestion";

/** Keeps the dragged range and the A/B side, as a stage will. */
function Adjustable(props: DecisionCardProps) {
  const [range, setRange] = useState({
    start: FILLER_WAVEFORM.start,
    end: FILLER_WAVEFORM.end,
  });
  const [side, setSide] = useState<AuditionSide>("A");
  return (
    <DecisionCard
      {...props}
      savedSeconds={range.end - range.start}
      waveform={{ ...FILLER_WAVEFORM, ...range, onAdjust: setRange }}
      audition={{ side, onSide: setSide }}
    />
  );
}

const handlers = {
  onVerb: fn(),
  onKeep: fn(),
  onLater: fn(),
  onOpenInEdit: fn(),
  onComment: fn(),
};

const meta: Meta<typeof DecisionCard> = {
  title: "Stages/Review/DecisionCard",
  component: DecisionCard,
  tags: ["autodocs"],
  args: {
    kind: "filler",
    title: "Remove “um, you know,”",
    time: "18:36",
    speaker: { name: "Jon", colorIndex: 1 },
    excerpt: <Suggestion segments={FILLER_EXCERPT} />,
    why: "Jon restarts the sentence; nobody talks over it.",
    waveform: { ...FILLER_WAVEFORM, onAdjust: fn() },
    savedSeconds: 0.8,
    audition: { side: "B", onSide: fn(), onHear: fn() },
    ...handlers,
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The focus surface for one decidable thing: kind line, plain title, a script excerpt with the Suggestion drawing, a 96 px waveform with edge handles, one plain why line, A/B and the Action bar (Keep left, the verb right, Later, Open in Edit). Kinds: Filler, Pause, Sound, Unsure word, Comment, Check. On phone it fills the screen with the Action bar as a 64 px dock; swipe right does the verb, left keeps, up moves on, from 80 px. A guest hears and comments but cannot decide, and opens Edit only with `canEdit`. Decisions are undoable, so nothing asks first.\n\n**Motion.** Animations come later: the card advances and the verb icon grows under a swipe with `--motion-panel`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof DecisionCard>;

export const Filler: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: /um, you know/ }),
    ).toBeVisible();
    await expect(canvas.getByText("Saves 0.8 s")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Cut" }));
    await expect(args.onVerb).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: "Keep" }));
    await expect(args.onKeep).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: "Later" }));
    await expect(args.onLater).toHaveBeenCalledOnce();
  },
};

export const Pause: Story = {
  args: {
    kind: "pause",
    title: "Shorten a 2.9 s pause to 0.6 s",
    time: "24:40",
    excerpt: <Suggestion kind="pause" length={2.9} to={0.6} />,
    why: "Nobody speaks, and the room is quiet.",
    savedSeconds: 2.3,
    waveform: {
      peaks: pausePeaks,
      windowStart: 1474,
      start: 1478.3,
      end: 1481.2,
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Shorten" }),
    ).toBeVisible();
  },
};

export const Sound: Story = {
  args: {
    kind: "sound",
    title: "Lower a laugh by 12 dB",
    time: "44:20",
    excerpt: undefined,
    why: "The laugh peaks over Rosa's next sentence.",
    savedSeconds: undefined,
    waveform: {
      peaks: fillerPeaks,
      windowStart: 2654,
      start: 2658,
      end: 2661,
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Lower" }),
    ).toBeVisible();
  },
};

export const Adjusting: Story = {
  render: (args) => <Adjustable {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "A" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const handle = canvas.getByRole("slider", { name: "End of the change" });
    handle.focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await expect(canvas.getByText("Saves 1.3 s")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "B" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

export const UnsureWord: Story = {
  args: {
    kind: "unsure-word",
    title: "Is this “uncle”?",
    time: "10:14",
    excerpt: <Suggestion segments={UNSURE_EXCERPT} />,
    why: "The transcriber was not sure of this word.",
    waveform: undefined,
    audition: undefined,
    unsure: {
      word: "uncle",
      guess: "uncle",
      step: { index: 1, total: 3 },
      onFix: fn(),
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Looks right" }),
    ).toBeEnabled();
    await userEvent.click(canvas.getByRole("button", { name: "Fix text" }));
    const field = canvas.getByRole("textbox", { name: "Fix text" });
    await userEvent.clear(field);
    await userEvent.type(field, "Uncle{Enter}");
    await expect(args.unsure?.onFix).toHaveBeenCalledWith("Uncle");
  },
};

export const CutWithUnsureWord: Story = {
  args: {
    title: "Remove “uh, my”",
    excerpt: <Suggestion segments={FILLER_WITH_UNSURE} />,
    unsure: { word: "uncle", guess: "uncle", onFix: fn(), onLooksRight: fn() },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Cut" })).toBeDisabled();
    await expect(
      canvas.getByText("Unsure word: is this", { exact: false }),
    ).toBeVisible();
  },
};

export const WithComment: Story = {
  args: {
    comment: {
      author: { name: "Rosa", colorIndex: 2 },
      time: "18:34",
      body: "I like the pause before this, can we keep some of it?",
      replies: 1,
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(/I like the pause/),
    ).toBeVisible();
  },
};

export const Comment: Story = {
  args: {
    kind: "comment",
    title: "Rosa asks about the pause",
    time: "11:42",
    excerpt: (
      <Suggestion
        segments={[
          { text: "…and that was the last time anyone saw the boat." },
        ]}
      />
    ),
    why: undefined,
    waveform: undefined,
    audition: undefined,
    comment: {
      author: { name: "Rosa", colorIndex: 2 },
      time: "11:42",
      body: "Can we keep the laugh here?",
      replies: 2,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Resolve" })).toBeVisible();
    await expect(canvas.getByText("2 replies")).toBeVisible();
  },
};

export const Check: Story = {
  args: {
    kind: "check",
    title: "Check the transcript before cutting",
    time: "0:00",
    speaker: undefined,
    excerpt: undefined,
    why: "Cuts are placed by words, so give the transcript a glance first.",
    waveform: undefined,
    audition: undefined,
    unsure: {
      word: "uncle",
      guess: "uncle",
      step: { index: 1, total: 3 },
      onFix: fn(),
      onLooksRight: fn(),
    },
  },
};

export const CutAnywayPrompt: Story = {
  args: {
    prompt: {
      verb: "cut",
      checkLabel: "Check 3 words",
      onConfirm: fn(),
      onCheck: fn(),
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(/transcript isn't checked yet/),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Cut anyway" }));
    await expect(args.prompt?.onConfirm).toHaveBeenCalledOnce();
  },
};

export const GuestSuggestion: Story = {
  args: { suggestedBy: "Rosa" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Suggested by Rosa"),
    ).toBeVisible();
  },
};

export const GuestReadOnly: Story = {
  args: { suggestedBy: "You", readOnly: true },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: "Cut" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Keep" })).toBeNull();
    await expect(
      canvas.queryByRole("button", { name: "Open in Edit" }),
    ).toBeNull();
    await expect(canvas.getByRole("group", { name: "Audition" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Comment" }));
    await expect(args.onComment).toHaveBeenCalledOnce();
  },
};

export const GuestEditor: Story = {
  args: { readOnly: true, canEdit: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Open in Edit" }),
    ).toBeVisible();
  },
};

export const Empty: Story = {
  args: {
    state: "empty",
    emptyAction: { label: "Go to Deliver", onClick: fn() },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Nothing to decide"),
    ).toBeVisible();
  },
};

export const Loading: Story = { args: { state: "loading" } };

export const LoadError: Story = {
  args: { state: "error", onRetry: fn() },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Try again" }),
    );
    await expect(args.onRetry).toHaveBeenCalledOnce();
  },
};

const phoneFrame = (width: string) => [
  (Story: () => React.ReactElement) => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        inlineSize: width,
        maxInlineSize: "100%",
        blockSize: "44rem",
      }}
    >
      <Story />
    </div>
  ),
];

export const Phone: Story = {
  args: { layout: "phone" },
  decorators: phoneFrame("22.5rem"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dock = canvas.getByRole("group", { name: "Actions" });
    await expect(
      within(dock).getByRole("button", { name: "Keep" }),
    ).toBeVisible();
    await expect(
      within(dock).getByRole("group", { name: "Audition" }),
    ).toBeVisible();
    await expect(
      within(dock).getByRole("button", { name: "Cut" }),
    ).toBeVisible();
  },
};

export const Phone390: Story = {
  name: "Phone 390",
  args: { layout: "phone" },
  decorators: phoneFrame("24.375rem"),
};

export const PhoneGuest: Story = {
  args: { layout: "phone", readOnly: true },
  decorators: phoneFrame("22.5rem"),
};

export const PhoneEmpty: Story = {
  args: { layout: "phone", state: "empty" },
  decorators: phoneFrame("22.5rem"),
};

export const PhoneSwipe: Story = {
  args: { layout: "phone" },
  decorators: phoneFrame("22.5rem"),
  play: async ({ args, canvasElement }) => {
    const body = canvasElement.querySelector(".sys-decision-body");
    if (!body) throw new Error("no card body");
    const swipe = async (dx: number, dy: number) => {
      await fireEvent.pointerDown(body, {
        clientX: 200,
        clientY: 300,
        isPrimary: true,
        pointerId: 1,
      });
      await fireEvent.pointerMove(body, {
        clientX: 200 + dx,
        clientY: 300 + dy,
        pointerId: 1,
      });
      await fireEvent.pointerUp(body, {
        clientX: 200 + dx,
        clientY: 300 + dy,
        pointerId: 1,
      });
    };
    await swipe(60, 0);
    await expect(args.onVerb).not.toHaveBeenCalled();
    await swipe(100, 0);
    await expect(args.onVerb).toHaveBeenCalledOnce();
    await swipe(-100, 0);
    await expect(args.onKeep).toHaveBeenCalledOnce();
    await swipe(0, -100);
    await expect(args.onLater).toHaveBeenCalledOnce();
  },
};
