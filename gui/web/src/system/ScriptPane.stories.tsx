import type { Meta, StoryObj } from "@storybook/react-vite";
import { type CSSProperties, useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { ScriptPane, type ScriptPaneProps } from "./ScriptPane";
import {
  CUT,
  cutMark,
  hugeTurn,
  longScript,
  MUTED,
  patchWords,
  RTL_TURNS,
  SCRIPT_TURNS,
  spanPatch,
  suggestedMark,
} from "./scriptFixtures";
import type { ScriptCaret, ScriptSelection, ScriptSpan } from "./scriptPieces";

const meta: Meta<typeof ScriptPane> = {
  title: "System/ScriptPane",
  component: ScriptPane,
  tags: ["autodocs"],
  args: {
    turns: SCRIPT_TURNS,
    onCaret: fn(),
    onSelect: fn(),
    onSelectionStart: fn(),
    onSelectionChange: fn(),
    onSelectionEnd: fn(),
    onFixText: fn(),
    onSeek: fn(),
    onPrimary: fn(),
    onClearSelection: fn(),
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
          "The transcript as a document (design-system element 14), view only. A 40 px header holds find, the unsure-words chip, the show-cut-text eye and the follow pin; below it, each turn has an 88 px margin with the speaker's 20 px avatar and first name, and the words run as plain text. There are no modes: a click places the caret and seeks, Shift extends, and the arrows move among words, cut pills and suggested runs (Left and Right by place, Up and Down by line, Home and End; Shift selects from the real anchor). The words, pills and runs are one tab stop. Space is left to Play/Pause; Enter selects a word, or runs the primary of a selection. Esc clears the selection. Alt+Shift+Left grows the selection at its start and Alt+Shift+Right shrinks it from the start. A words selection shows two grips, one at each end, that drag by word (see Stages/Edit/ScriptPane SelectionHandles), and a cut pill inside it takes the selection tint. Left from a turn's first word enters the margin, where Up and Down walk the speaker's name and the time and Right returns to the words. The host owns what each intent does, and may omit the callbacks it does not serve, as a guest's pane does.\n\nWord states. The playing word has a 2 px accent underline. A cut collapses into a Seam pill with the removed length, or, with the eye on, shows struck. A suggested cut is the hatched Suggestion run. Muted words are grey behind a speaker-slash glyph. Find hits take a tint and the current one an outline. Unsure words have a dotted underline. Words just restored sit on the keep tint until the next action. A selection is the selection tint, and a caret is a 2 px bar before a word, in the person's colour when it is somebody else's.\n\nStatus. Loading shows the skeleton. Transcribing shows a Status row with the percent and the time still to come. No transcript shows the Cover with the one button that starts the job. Out of date shows a Status row with Update. When follow is off a Back to playhead pill sits at the bottom centre. A guest reads, selects and comments; the pane marks itself read only.\n\nThe pane scrolls inside its host's height. The pane reports a hand scroll through onUserScroll so the host can turn follow off, and scrollToWord on its ref lands a word in view. It draws the turns it is given, so a host that virtualizes passes a window of turns with the episode's word indices. Under a coarse pointer the header buttons, the cut pill, the speaker's name and the time are 44 px tall and hit-testable all over. A word and a suggested run keep the height of their line (26 or 28 px) and the width of the word: a 44 px region would reach into the lines above and below and take their presses, so running text is the one place the 44 px floor is the line pitch.\n\nGestures. A click or tap selects a word at once and seeks. A mouse drag selects from the pressed word to the word under the pointer across turns (a pill or run in the way is taken whole), Shift-click and Shift-drag extend, and a double-click or double-tap, or Enter or F2 on a selected word, asks the host for Fix text; typing never does. On touch a long press selects the word and shows the grips, and moving on extends it; a swipe before the hold scrolls. Esc, a lost pointer, a blur or a second finger cancel a drag. The browser's own text selection is off in the pane and the copy event copies the selected words. The Gestures stories show what the pane tells the host in a log under the pane.\n\n**Motion.** None. The playing underline and the restored tint are static.",
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
        onClearSelection={() => {
          props.onClearSelection?.();
          setSelection(null);
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

export const MarginKeys: Story = {
  ...live,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    canvas.getByRole("button", { name: "Thanks" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    const speaker = canvas.getByRole("button", {
      name: "Anneke de Vries, change speaker",
    });
    await expect(speaker).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onSpeaker).toHaveBeenLastCalledWith("t2", speaker);
    await userEvent.keyboard("{ArrowDown}");
    await expect(
      canvas.getByRole("button", { name: "Play from 12:19" }),
    ).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByRole("button", { name: "Thanks" })).toHaveFocus();
  },
};

export const EscClears: Story = {
  ...live,
  args: { selection: { kind: "words", anchor: 12, head: 14 } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    canvas.getByRole("button", { name: "small (selected)" }).focus();
    await userEvent.keyboard("{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}");
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "2 words selected: room can",
    );
    await userEvent.keyboard("{Escape}");
    await expect(args.onClearSelection).toHaveBeenCalledTimes(1);
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Selection cleared",
    );
  },
};

/** The host the gesture stories share: local selection, a Fix text field and a log of what the pane told it. */
function GestureLive(props: ScriptPaneProps) {
  const [selection, setSelection] = useState<ScriptSelection | null>(
    props.selection ?? null,
  );
  const [editing, setEditing] = useState<ScriptSpan | null>(null);
  const [log, setLog] = useState<readonly string[]>([]);
  const note = (line: string) => setLog((all) => [...all.slice(-4), line]);
  const phone = props.layout === "phone";
  return (
    <div style={phone ? phoneStack : stack}>
      <div style={phone ? phoneFrame : frame}>
        <ScriptPane
          {...props}
          selection={selection}
          editing={editing}
          renderEditor={() => (
            <input
              aria-label="Fix text"
              defaultValue="fixing"
              ref={(el) => el?.focus()}
            />
          )}
          onSelect={(next) => {
            props.onSelect?.(next);
            setSelection(next);
          }}
          onClearSelection={() => {
            props.onClearSelection?.();
            setSelection(null);
          }}
          onSelectionStart={(anchor, gesture) => {
            note(`start ${anchor} ${gesture.source} ${gesture.intent}`);
            return props.onSelectionStart?.(anchor, gesture);
          }}
          onSelectionChange={(anchor, head, gesture) => {
            note(`change ${anchor} to ${head}`);
            props.onSelectionChange?.(anchor, head, gesture);
          }}
          onSelectionEnd={(anchor, head, gesture) => {
            note(
              `end ${anchor} to ${head} ${gesture.committed ? "committed" : "cancelled"}`,
            );
            props.onSelectionEnd?.(anchor, head, gesture);
          }}
          onFixText={(span, via) => {
            note(`fix ${span.start} to ${span.end} by ${via}`);
            props.onFixText?.(span, via);
            setEditing(span);
          }}
        />
      </div>
      <ol aria-label="What the pane told the host" style={logStyle}>
        {log.map((line, at) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the log only appends and shifts
          <li key={`${at}-${line}`}>{line}</li>
        ))}
      </ol>
    </div>
  );
}

const stack: CSSProperties = { display: "grid", gap: "var(--space-3)" };
const phoneStack: CSSProperties = { ...stack, inlineSize: "22.5rem" };
const logStyle: CSSProperties = {
  margin: 0,
  paddingInlineStart: "1.25rem",
  minBlockSize: "5.5rem",
  font: "var(--font-size-small) var(--font-family-mono)",
  overflowWrap: "anywhere",
};

const gest: Pick<Story, "render"> = {
  render: (args) => <GestureLive {...args} />,
};

/** jsdom has no layout, so a play that aims at where a word is drawn runs only in a real browser; the unit tests cover jsdom. */
const noLayout = (el: Element) => el.getBoundingClientRect().width === 0;

const centreOf = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
};

type Kind = { pointerId: number; pointerType: "mouse" | "touch" };
const MOUSE: Kind = { pointerId: 1, pointerType: "mouse" };
const TOUCH: Kind = { pointerId: 2, pointerType: "touch" };

/** One pointer event at an element's centre, as the browser would send it. */
function pointer(
  type: "pointerdown" | "pointermove" | "pointerup",
  target: Element,
  kind: Kind,
) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      ...kind,
      ...centreOf(target),
    }),
  );
}

/** A mouse drag: press on one word, move to another and, unless `keep`, let go. */
function dragBetween(from: HTMLElement, to: HTMLElement, keep = false) {
  pointer("pointerdown", from, MOUSE);
  pointer("pointermove", to, MOUSE);
  if (!keep) pointer("pointerup", to, MOUSE);
}

const lastSelect = (args: ScriptPaneProps) =>
  (args.onSelect as ReturnType<typeof fn>).mock.calls.at(-1)?.[0];

export const MouseDrag: Story = {
  ...gest,
  play: async ({ canvasElement, args }) => {
    if (noLayout(canvasElement)) return;
    const canvas = within(canvasElement);
    dragBetween(
      canvas.getByRole("button", { name: "small" }),
      canvas.getByRole("button", { name: "one." }),
    );
    await expect(lastSelect(args)).toEqual({
      kind: "words",
      anchor: 12,
      head: 19,
    });
    await expect(args.onSelectionStart).toHaveBeenCalledWith(12, {
      source: "mouse",
      intent: "drag",
      shift: false,
      alt: false,
      mod: false,
    });
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "8 words selected: small room can sound like a large one.",
    );
  },
};

export const DragAcrossTurns: Story = {
  ...gest,
  play: async ({ canvasElement, args }) => {
    if (noLayout(canvasElement)) return;
    const canvas = within(canvasElement);
    dragBetween(
      canvas.getByRole("button", { name: "large" }),
      canvas.getByRole("button", { name: "having" }),
    );
    await expect(lastSelect(args)).toEqual({
      kind: "words",
      anchor: 18,
      head: 22,
    });
  },
};

export const DragThroughACut: Story = {
  ...gest,
  args: {
    turns: patchWords(SCRIPT_TURNS, spanPatch(13, 14, { mark: CUT })),
  },
  play: async ({ canvasElement, args }) => {
    if (noLayout(canvasElement)) return;
    const canvas = within(canvasElement);
    dragBetween(
      canvas.getByRole("button", { name: "small" }),
      canvas.getByRole("button", { name: "sound" }),
    );
    await expect(lastSelect(args)).toEqual({
      kind: "words",
      anchor: 12,
      head: 15,
    });
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "small cut room can sound",
    );
  },
};

export const DragStaysUncommittedUntilRelease: Story = {
  ...gest,
  play: async ({ canvasElement, args }) => {
    if (noLayout(canvasElement)) return;
    const canvas = within(canvasElement);
    dragBetween(
      canvas.getByRole("button", { name: "small" }),
      canvas.getByRole("button", { name: "sound" }),
      true,
    );
    await expect(args.onSelect).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(canvasElement.querySelector(".sys-script-body")).toHaveAttribute(
        "data-selecting",
      ),
    );
    const sound = canvasElement.querySelector('[data-stop="15"]');
    if (!sound) throw new Error("No word 15");
    pointer("pointerup", sound, MOUSE);
    await expect(args.onSelect).toHaveBeenCalledTimes(1);
  },
};

export const EscapeCancelsDrag: Story = {
  ...gest,
  args: { selection: { kind: "words", anchor: 0, head: 1 } },
  play: async ({ canvasElement, args }) => {
    if (noLayout(canvasElement)) return;
    const canvas = within(canvasElement);
    dragBetween(
      canvas.getByRole("button", { name: "small" }),
      canvas.getByRole("button", { name: "sound" }),
      true,
    );
    await userEvent.keyboard("{Escape}");
    await expect(args.onSelectionEnd).toHaveBeenLastCalledWith(
      12,
      15,
      expect.objectContaining({ committed: false }),
    );
    await expect(args.onSelect).not.toHaveBeenCalled();
    await expect(args.onClearSelection).not.toHaveBeenCalled();
    await expect(
      canvas.getByRole("button", { name: "Welcome (selected)" }),
    ).toBeVisible();
  },
};

export const ShiftClickExtends: Story = {
  ...gest,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await user.click(canvas.getByRole("button", { name: "small" }));
    await expect(lastSelect(args)).toEqual({
      kind: "words",
      anchor: 12,
      head: 12,
    });
    await user.keyboard("{Shift>}");
    await user.click(canvas.getByRole("button", { name: "sound" }));
    await user.keyboard("{/Shift}");
    await expect(lastSelect(args)).toEqual({
      kind: "words",
      anchor: 12,
      head: 15,
    });
  },
};

export const ClickSelectsAWord: Story = {
  ...gest,
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "small" }),
    );
    await expect(args.onSeek).toHaveBeenLastCalledWith(12);
    await expect(
      within(canvasElement).getByRole("button", { name: "small (selected)" }),
    ).toBeVisible();
    await expect(args.onFixText).not.toHaveBeenCalled();
  },
};

export const DoubleClickFixesText: Story = {
  ...gest,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.dblClick(canvas.getByRole("button", { name: "small" }));
    await expect(args.onFixText).toHaveBeenCalledWith(
      { start: 12, end: 12 },
      "double-click",
    );
    await expect(
      canvas.getByRole("textbox", { name: "Fix text" }),
    ).toBeVisible();
  },
};

export const EnterAndF2FixText: Story = {
  ...gest,
  args: { selection: { kind: "words", anchor: 12, head: 14 } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    canvas.getByRole("button", { name: "room (selected)" }).focus();
    await userEvent.keyboard("{F2}");
    await expect(args.onFixText).toHaveBeenLastCalledWith(
      { start: 12, end: 14 },
      "f2",
    );
    await expect(
      canvas.getByRole("textbox", { name: "Fix text" }),
    ).toBeVisible();
  },
};

export const TypingNeverEdits: Story = {
  ...gest,
  args: { selection: { kind: "words", anchor: 12, head: 14 } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    canvas.getByRole("button", { name: "room (selected)" }).focus();
    await userEvent.keyboard("cxim.a");
    await expect(canvas.queryByRole("textbox")).toBeNull();
    await expect(args.onFixText).not.toHaveBeenCalled();
  },
};

export const TouchLongPressThenDrag: Story = {
  ...gest,
  args: { layout: "phone" },
  play: async ({ canvasElement, args }) => {
    if (noLayout(canvasElement)) return;
    const canvas = within(canvasElement);
    const from = canvas.getByRole("button", { name: "small" });
    const to = canvas.getByRole("button", { name: "sound" });
    pointer("pointerdown", from, TOUCH);
    await waitFor(() => expect(args.onSelectionStart).toHaveBeenCalled());
    await expect(args.onSelectionStart).toHaveBeenCalledWith(
      12,
      expect.objectContaining({ source: "touch", intent: "hold" }),
    );
    pointer("pointermove", to, TOUCH);
    pointer("pointerup", to, TOUCH);
    await expect(lastSelect(args)).toEqual({
      kind: "words",
      anchor: 12,
      head: 15,
    });
    await expect(canvasElement.querySelector(".sys-handle")).not.toBeNull();
  },
};

export const RightToLeftTurn: Story = {
  ...gest,
  args: { turns: RTL_TURNS },
  play: async ({ canvasElement, args }) => {
    if (noLayout(canvasElement)) return;
    const canvas = within(canvasElement);
    dragBetween(
      canvas.getByRole("button", { name: "לכולם" }),
      canvas.getByRole("button", { name: "להקלטה" }),
    );
    await expect(lastSelect(args)).toEqual({
      kind: "words",
      anchor: 7,
      head: 10,
    });
  },
};

export const LongTranscript: Story = {
  ...gest,
  args: { turns: longScript(60) },
  play: async ({ canvasElement }) => {
    if (noLayout(canvasElement)) return;
    const body = canvasElement.querySelector(".sys-script-body");
    await expect((body?.scrollHeight ?? 0) > (body?.clientHeight ?? 0)).toBe(
      true,
    );
  },
};

/** The gesture host with nothing played, for the real-browser specs to drive. */
export const Gestures: Story = { ...gest };

export const PhoneGestures: Story = {
  ...gest,
  args: { layout: "phone" },
};

export const RtlGestures: Story = {
  ...gest,
  args: { turns: RTL_TURNS },
};

export const LongGestures: Story = {
  ...gest,
  args: { turns: longScript(60) },
};

/**
 * Axe rules the jsdom run (allStories.test.tsx) turns off for HugeGestures. The story is one 1500-word turn, about 3000 nodes under
 * one parent, and each of these four costs 4.5 to 5.6 s on its own there (unloaded, node 22, 4 cores), against a 5 s limit for the
 * whole story. Their cost grows faster than the word count: button-name takes 1.0 s at 500 words, 1.9 s at 1000 and 5.6 s at 1500.
 * It is the single long turn, not the word count, that does it: for LongGestures (60 turns of 24 words, 1440 words) axe takes 1.3 s
 * with every rule on, and the whole story 3 s under load in the full run, so it keeps them all. Turning off three of the four still leaves 4 to 4.7 s, so all four go; the whole run then takes 0.6 s unloaded and
 * 0.8 s under three busy loops. Every other rule stays on. Playwright (e2e/axe.ts, wcag2a and wcag2aa) still runs button-name and
 * nested-interactive on this story; region and tabindex are best practices that only this jsdom run checks.
 */
const slowSharedCostRules = [
  "button-name",
  "nested-interactive",
  "region",
  "tabindex",
];

export const HugeGestures: Story = {
  ...gest,
  args: { turns: hugeTurn(1500) },
  parameters: {
    a11y: {
      config: {
        rules: slowSharedCostRules.map((id) => ({ id, enabled: false })),
      },
    },
  },
};
