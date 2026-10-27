import type { Meta, StoryObj } from "@storybook/react-vite";
import { type CSSProperties, useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { ScriptPane, type ScriptPaneProps } from "./ScriptPane";
import {
  CUT,
  cutMark,
  MUTED,
  patchWords,
  SCRIPT_TURNS,
  spanPatch,
  suggestedMark,
} from "./scriptFixtures";
import type { ScriptCaret, ScriptSelection } from "./scriptPieces";

const meta: Meta<typeof ScriptPane> = {
  title: "System/ScriptPane",
  component: ScriptPane,
  tags: ["autodocs"],
  args: {
    turns: SCRIPT_TURNS,
    onCaret: fn(),
    onSelect: fn(),
    onSeek: fn(),
    onPrimary: fn(),
    onSeamSelect: fn(),
    onSuggestionSelect: fn(),
    onSeekTurn: fn(),
    onSpeaker: fn(),
    onUserScroll: fn(),
    onFind: fn(),
    onNextUnsure: fn(),
    onShowCutTextChange: fn(),
    onFollowChange: fn(),
    onBackToPlayhead: fn(),
  },
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The transcript as a document (design-system element 14), view only. A 40 px header holds find, the unsure-words chip, the show-cut-text eye and the follow pin; below it, each turn has an 88 px margin with the speaker's 20 px avatar and first name, and the words run as plain text. There are no modes: a click places the caret and seeks, Shift extends, and the arrows move among words, cut pills and suggested runs (Left and Right, Home and End; Shift selects from the real anchor). The words, pills and runs are one tab stop. Space is left to Play/Pause; Enter selects a word, or runs the primary of a selection. The host owns what each intent does, and may omit the callbacks it does not serve, as a guest's pane does.\n\nWord states. The playing word has a 2 px accent underline. A cut collapses into a Seam pill with the removed length, or, with the eye on, shows struck. A suggested cut is the hatched Suggestion run. Muted words are grey behind a speaker-slash glyph. Find hits take a tint and the current one an outline. Unsure words have a dotted underline. Words just restored sit on the keep tint until the next action. A selection is the selection tint, and a caret is a 2 px bar before a word, in the person's colour when it is somebody else's.\n\nStatus. Loading shows the skeleton. Transcribing shows a Status row with the percent and the time still to come. No transcript shows the Cover with the one button that starts the job. Out of date shows a Status row with Update. When follow is off a Back to playhead pill sits at the bottom centre. A guest reads, selects and comments; the pane marks itself read only.\n\nThe pane scrolls inside its host's height. The pane reports a hand scroll through onUserScroll so the host can turn follow off, and scrollToWord on its ref lands a word in view. It draws the turns it is given, so a host that virtualizes passes a window of turns with the episode's word indices. Under a coarse pointer the header buttons, the pill, the words and the runs have 44 px hit regions.\n\n**Motion.** None. The playing underline and the restored tint are static.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ScriptPane>;

const frame: CSSProperties = {
  blockSize: "34rem",
  maxBlockSize: "100dvh",
  border: "1px solid var(--color-border)",
};

const phoneFrame: CSSProperties = { ...frame, inlineSize: "22.5rem" };

function Live(props: ScriptPaneProps) {
  const [selection, setSelection] = useState<ScriptSelection | null>(
    props.selection ?? null,
  );
  const [caret, setCaret] = useState<number | undefined>(undefined);
  const [showCutText, setShowCutText] = useState(props.showCutText ?? false);
  const [following, setFollowing] = useState(props.following ?? true);
  const carets: readonly ScriptCaret[] =
    caret === undefined
      ? (props.carets ?? [])
      : [{ before: caret }, ...(props.carets ?? []).filter((c) => c.person)];
  return (
    <div style={props.layout === "phone" ? phoneFrame : frame}>
      <ScriptPane
        {...props}
        selection={selection}
        carets={carets}
        showCutText={showCutText}
        following={following}
        onCaret={(before) => {
          props.onCaret?.(before);
          setCaret(before);
          setSelection(null);
        }}
        onSelect={(next) => {
          props.onSelect?.(next);
          setSelection(next);
        }}
        onSeamSelect={(id) => {
          props.onSeamSelect?.(id);
          setSelection({ kind: "cut", id });
        }}
        onSuggestionSelect={(id) => {
          props.onSuggestionSelect?.(id);
          setSelection({ kind: "suggestion", id });
        }}
        onShowCutTextChange={(next) => {
          props.onShowCutTextChange?.(next);
          setShowCutText(next);
        }}
        onFollowChange={(next) => {
          props.onFollowChange?.(next);
          setFollowing(next);
        }}
      />
    </div>
  );
}

const live: Pick<Story, "render"> = { render: (args) => <Live {...args} /> };

export const Reading: Story = {
  ...live,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "small" }));
    await expect(args.onCaret).toHaveBeenLastCalledWith(12);
    await expect(args.onSeek).toHaveBeenLastCalledWith(12);
    await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{/Shift}");
    await expect(
      canvas.getByRole("button", { name: "small (selected)" }),
    ).toHaveAttribute("data-selected", "");
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "3 words selected: small room can",
    );
    await expect(
      canvas.getByRole("group", { name: "Maya, 12:04" }),
    ).toBeVisible();
  },
};

export const Playing: Story = {
  ...live,
  args: { playing: 8 },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "talking" }),
    ).toHaveAttribute("aria-current", "true");
  },
};

export const TwoPlaying: Story = {
  ...live,
  args: { playing: [8, 22] },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getAllByRole("button", { current: true }),
    ).toHaveLength(2);
  },
};

export const WordsSelected: Story = {
  ...live,
  args: { selection: { kind: "words", anchor: 12, head: 14 }, playing: 3 },
  play: async ({ canvasElement }) => {
    const pressed = [
      ...canvasElement.querySelectorAll(".sys-script-word[data-selected]"),
    ].map((button) => button.textContent);
    await expect(pressed).toEqual(["small", "room", "can"]);
  },
};

export const WithCuts: Story = {
  ...live,
  args: {
    turns: patchWords(SCRIPT_TURNS, {
      ...spanPatch(46, 48, { mark: CUT }),
      ...spanPatch(28, 28, { mark: cutMark("cut-2", 0.3) }),
      ...spanPatch(29, 29, { mark: cutMark("cut-3", 0.4) }),
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Cut, 1.1 s removed" }),
    );
    await expect(args.onSeamSelect).toHaveBeenLastCalledWith("cut-1");
    await expect(
      canvas.getByRole("button", { name: "Cut, 1.1 s removed" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.getByRole("button", { name: "Cut, 0.3 s removed" }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(
      canvas.getByRole("button", { name: "Cut, 0.4 s removed" }),
    ).toBeVisible();
  },
};

export const ShowCutText: Story = {
  ...live,
  args: {
    showCutText: true,
    turns: patchWords(SCRIPT_TURNS, spanPatch(46, 48, { mark: CUT })),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "um, (cut)" }),
    ).toHaveAttribute("data-state", "cut");
    await expect(canvas.queryByRole("button", { name: /^Cut, / })).toBeNull();
    await userEvent.click(
      canvas.getByRole("button", { name: "Show cut text" }),
    );
    await expect(
      canvas.getByRole("button", { name: "Cut, 1.1 s removed" }),
    ).toBeVisible();
  },
};

export const WithSuggestions: Story = {
  ...live,
  args: {
    turns: patchWords(SCRIPT_TURNS, {
      ...spanPatch(46, 48, { mark: suggestedMark("sugg-1") }),
      ...spanPatch(31, 31, { mark: suggestedMark("sugg-2") }),
      ...spanPatch(32, 32, { mark: suggestedMark("sugg-3") }),
    }),
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Suggested cut: um, you know,",
      }),
    );
    await expect(args.onSuggestionSelect).toHaveBeenLastCalledWith("sugg-1");
  },
};

export const LowConfidence: Story = {
  ...live,
  args: {
    turns: patchWords(SCRIPT_TURNS, {
      26: { lowConfidence: true },
      37: { lowConfidence: true },
      52: { lowConfidence: true },
    }),
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "3 unsure words, go to the next",
      }),
    );
    await expect(args.onNextUnsure).toHaveBeenCalledOnce();
  },
};

export const FindMatches: Story = {
  ...live,
  args: {
    matches: [
      { start: 15, end: 15 },
      { start: 44, end: 44 },
      { start: 12, end: 14 },
    ],
    currentMatch: 2,
  },
  play: async ({ canvasElement }) => {
    const found = [...canvasElement.querySelectorAll("[data-found]")].map(
      (el) => `${el.textContent}:${el.getAttribute("data-found")}`,
    );
    await expect(found).toEqual([
      "small:current",
      "room:current",
      "can:current",
      "sound:match",
      "us.:match",
    ]);
  },
};

export const FixTextSlot: Story = {
  ...live,
  args: {
    editing: { start: 12, end: 13 },
    renderEditor: () => (
      <input aria-label="Fix text" defaultValue="small room" />
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("textbox", { name: "Fix text" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "small" })).toBeNull();
  },
};

export const Transcribing: Story = {
  ...live,
  args: {
    turns: SCRIPT_TURNS.slice(0, 2),
    status: { kind: "transcribing", progress: 0.42, notYet: "12:00 to 52:10" },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("progressbar", { name: "Transcribing" }),
    ).toHaveAttribute("aria-valuenow", "42");
    await expect(
      canvas.getByText("Not transcribed yet · 12:00 to 52:10"),
    ).toBeVisible();
  },
};

export const NoTranscript: Story = {
  ...live,
  args: { turns: [], status: { kind: "empty", onTranscribe: fn() } },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Transcribe this episode",
      }),
    );
    if (args.status?.kind !== "empty") throw new Error("Wrong status");
    await expect(args.status.onTranscribe).toHaveBeenCalledOnce();
  },
};

export const OutOfDate: Story = {
  ...live,
  args: { status: { kind: "outOfDate", onUpdate: fn() } },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Update" }),
    );
    if (args.status?.kind !== "outOfDate") throw new Error("Wrong status");
    await expect(args.status.onUpdate).toHaveBeenCalledOnce();
  },
};

export const Loading: Story = {
  ...live,
  args: { turns: [], status: { kind: "loading", elapsedMs: 1000 } },
};

export const GuestCommenter: Story = {
  ...live,
  args: {
    guest: "commenter",
    selection: { kind: "words", anchor: 12, head: 14 },
    turns: patchWords(SCRIPT_TURNS, {
      ...spanPatch(46, 48, { mark: suggestedMark("sugg-1") }),
    }),
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Read only · you can comment"),
    ).toBeVisible();
  },
};

export const GuestViewer: Story = {
  render: (args) => (
    <div style={frame}>
      <ScriptPane turns={args.turns} guest="viewer" playing={8} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Read only")).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "Find in transcript" }),
    ).toBeNull();
    await expect(canvas.getByRole("button", { name: "talking" })).toBeVisible();
  },
};

export const Phone: Story = {
  ...live,
  args: {
    layout: "phone",
    playing: 8,
    following: false,
    selection: { kind: "words", anchor: 12, head: 14 },
    turns: patchWords(SCRIPT_TURNS, spanPatch(46, 48, { mark: CUT })),
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Back to playhead" }),
    );
    await expect(args.onBackToPlayhead).toHaveBeenCalledOnce();
  },
};

export const BackToPlayhead: Story = {
  ...live,
  args: { playing: 8, following: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Follow the playhead" }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(
      canvas.getByRole("button", { name: "Back to playhead" }),
    ).toBeVisible();
  },
};

export const Turns: Story = {
  ...live,
  args: {
    playing: 22,
    carets: [
      { before: 45 },
      { before: 30, person: { name: "Joss", colorIndex: 2 } },
    ],
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getAllByRole("group").map((g) => g.getAttribute("aria-label")),
    ).toEqual(["Maya, 12:04", "Anneke, 12:19", "Anneke, 12:41", "Maya, 12:47"]);
    await expect(canvas.getAllByText("Anneke")).toHaveLength(1);
    await expect(canvas.getByText("Joss's cursor")).toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole("button", { name: "Play from 12:19" }),
    );
    await expect(args.onSeekTurn).toHaveBeenLastCalledWith("t2");
  },
};

export const JustRestored: Story = {
  ...live,
  args: {
    turns: patchWords(SCRIPT_TURNS, spanPatch(46, 48, { restored: true })),
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "um, (restored)" }),
    ).toHaveAttribute("data-restored", "");
  },
};

export const MutedWords: Story = {
  ...live,
  args: {
    turns: patchWords(SCRIPT_TURNS, spanPatch(12, 14, { mark: MUTED })),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "small (muted)" }),
    ).toHaveAttribute("data-state", "muted");
  },
};
