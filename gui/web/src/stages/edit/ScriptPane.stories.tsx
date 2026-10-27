import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { ActionBar, SelectionCount } from "../../system/ActionBar";
import { PEOPLE } from "../../system/prepareFixtures";
import { ScriptPane, type ScriptPaneProps } from "../../system/ScriptPane";
import {
  CUT,
  MUTED,
  patchWords,
  replaceSpan,
  SCRIPT_TURNS,
  spanPatch,
  suggestedMark,
  textOfSpan,
} from "../../system/scriptFixtures";
import type { ScriptSpan, ScriptTurn } from "../../system/scriptPieces";
import { spanOf } from "../../system/scriptSelection";
import { FixTextField } from "./FixTextField";
import { SpeakerPopover } from "./SpeakerPopover";
import { scriptFrame, useLiveScript, useSelectionAnchor } from "./scriptDemo";

const meta: Meta<typeof ScriptPane> = {
  title: "Stages/Edit/ScriptPane",
  component: ScriptPane,
  args: {
    turns: SCRIPT_TURNS,
    onCaret: fn(),
    onSelect: fn(),
    onSeek: fn(),
    onSeamSelect: fn(),
    onSuggestionSelect: fn(),
    onClearSelection: fn(),
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
          "The Script pane in the Edit stage: the System pane with the Action bar over a selection, at the 400 px split width, in Script focus (Shift+T, the pane on its own at the stage width) and on a phone with the dock. The pane is a view; these stories keep the selection, the caret and the edits in local state so Shift and the arrows, the selection handles, Esc and Fix text all work.\n\nSelection. Shift with the arrows extends by word (Up and Down by line); Alt+Shift+Left grows the selection at its start and Alt+Shift+Right shrinks it from the start; Esc clears it; the two handles drag an end by word. Fix text opens an inline field over the selected words: Enter or a click outside commits, Esc puts the words back, and focus returns to the first word. The speaker's name opens the speaker popover, and Left from a turn's first word walks the keyboard into the margin.\n\n**Motion.** None.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ScriptPane>;

const WORD_VERBS = [
  { id: "hear" },
  { id: "comment" },
  { id: "fixText" },
] as const;

type EditProps = {
  args: ScriptPaneProps;
  width: string;
  phone?: boolean;
  editing?: ScriptSpan;
};

function Edit({ args, width, phone = false, editing: initial }: EditProps) {
  const [turns, setTurns] = useState<readonly ScriptTurn[]>(args.turns);
  const [editing, setEditing] = useState<ScriptSpan | null>(initial ?? null);
  const { pane, selection, setSelection } = useLiveScript({ ...args, turns });
  const [host, anchor] = useSelectionAnchor(selection, editing !== null);
  const span = spanOf(selection);
  const verbs = (
    <>
      {phone && span && !editing ? (
        <ActionBar
          placement={{ form: "dock" }}
          items={WORD_VERBS}
          primary={{ id: "cut" }}
          onVerb={(id) => id === "fixText" && setEditing(span)}
        />
      ) : null}
      {!phone && anchor && span && !editing ? (
        <ActionBar
          placement={{ form: "floating", anchorRef: anchor }}
          leading={<SelectionCount count={span.end - span.start + 1} />}
          items={WORD_VERBS}
          primary={{ id: "cut" }}
          onVerb={(id) => id === "fixText" && setEditing(span)}
        />
      ) : null}
    </>
  );
  return (
    <div ref={host} style={scriptFrame(width)}>
      <ScriptPane
        {...pane}
        layout={phone ? "phone" : "desktop"}
        editing={editing}
        renderEditor={(open) => (
          <FixTextField
            value={textOfSpan(turns, open)}
            label={
              open.end > open.start
                ? `Fix text, ${open.end - open.start + 1} words`
                : "Fix text"
            }
            onDone={(text) => {
              setEditing(null);
              if (text === null) return;
              setTurns(replaceSpan(turns, open, text));
              setSelection({
                kind: "words",
                anchor: open.start,
                head: open.start + text.split(" ").length - 1,
              });
            }}
          />
        )}
      />
      {verbs}
    </div>
  );
}

const edit =
  (width: string, extra: Partial<EditProps> = {}): Story["render"] =>
  (args) => <Edit args={args} width={width} {...extra} />;

export const WithActionBar: Story = {
  render: edit("25rem"),
  args: { selection: { kind: "words", anchor: 12, head: 14 }, playing: 3 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      [
        ...canvasElement.querySelectorAll(".sys-script-word[data-selected]"),
      ].map((b) => b.textContent),
    ).toEqual(["small", "room", "can"]);
    await expect(
      await canvas.findByRole("button", { name: "Cut" }),
    ).toBeVisible();
    canvas.getByRole("button", { name: "can (selected)" }).focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "4 words selected: small room can sound",
    );
  },
};

export const CutsAndSuggestions: Story = {
  render: edit("25rem"),
  args: {
    playing: 22,
    selection: { kind: "cut", id: "cut-1" },
    turns: patchWords(SCRIPT_TURNS, {
      ...spanPatch(46, 48, { mark: CUT }),
      ...spanPatch(31, 33, { mark: suggestedMark("sugg-1") }),
      ...spanPatch(12, 13, { mark: MUTED }),
      26: { lowConfidence: true },
      37: { lowConfidence: true },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Cut, 1.1 s removed" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.getByRole("button", { name: "2 unsure words, go to the next" }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: /^Suggested cut: / }),
    );
    await expect(
      canvas.getByRole("button", { name: "Cut, 1.1 s removed" }),
    ).toHaveAttribute("aria-pressed", "false");
  },
};

export const PhoneWithDock: Story = {
  render: edit("22.5rem", { phone: true }),
  args: { selection: { kind: "words", anchor: 12, head: 14 }, playing: 3 },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Cut" }),
    ).toBeVisible();
  },
};

export const ScriptFocus: Story = {
  render: edit("100%"),
  args: {
    playing: 8,
    selection: { kind: "words", anchor: 12, head: 14 },
    turns: patchWords(SCRIPT_TURNS, {
      ...spanPatch(46, 48, { mark: CUT }),
      26: { lowConfidence: true },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas
        .getAllByRole("group", { name: /, \d+:\d+$/ })
        .map((g) => g.getAttribute("aria-label")),
    ).toEqual(["Maya, 12:04", "Anneke, 12:19", "Anneke, 12:41", "Maya, 12:47"]);
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "3 words selected: small room can",
    );
  },
};

export const SelectionHandles: Story = {
  render: edit("25rem"),
  args: { selection: { kind: "words", anchor: 12, head: 14 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("slider", { name: "Selection start" }),
    ).toHaveAttribute("aria-valuetext", "before small");
    await expect(
      canvas.getByRole("slider", { name: "Selection end" }),
    ).toHaveAttribute("aria-valuetext", "after can");
  },
};

export const SelectionHandlesByKeyboard: Story = {
  render: edit("25rem"),
  args: { selection: { kind: "words", anchor: 12, head: 14 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const end = await canvas.findByRole("slider", { name: "Selection end" });
    end.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "5 words selected: small room can sound like",
    );
    await expect(end).toHaveAttribute("aria-valuetext", "after like");
    const start = canvas.getByRole("slider", { name: "Selection start" });
    start.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "4 words selected: room can sound like",
    );
    canvas.getByRole("button", { name: "like (selected)" }).focus();
    await userEvent.keyboard("{Alt>}{Shift>}{ArrowLeft}{/Shift}{/Alt}");
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "5 words selected: small room can sound like",
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(canvas.queryAllByRole("slider")).toHaveLength(0),
    );
  },
};

export const PhoneSelectionHandles: Story = {
  render: edit("22.5rem", { phone: true }),
  args: { selection: { kind: "words", anchor: 12, head: 14 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("slider", { name: "Selection start" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("slider", { name: "Selection end" }),
    ).toBeVisible();
  },
};

export const FixTextOpen: Story = {
  render: edit("25rem", { editing: { start: 12, end: 12 } }),
  args: { selection: { kind: "words", anchor: 12, head: 12 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByRole("textbox", { name: "Fix text" });
    await expect(field).toHaveFocus();
    await expect(field).toHaveValue("small");
    await userEvent.keyboard("tiny{Escape}");
    await expect(canvas.queryByRole("textbox")).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "small (selected)" }),
    ).toHaveFocus();
    await userEvent.click(
      await canvas.findByRole("button", { name: "Fix text" }),
    );
    await userEvent.keyboard("smaller{Enter}");
    await expect(
      canvas.getByRole("button", { name: "smaller (selected)" }),
    ).toHaveFocus();
  },
};

export const FixTextMultiWord: Story = {
  render: edit("25rem", { editing: { start: 12, end: 14 } }),
  args: { selection: { kind: "words", anchor: 12, head: 14 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByRole("textbox", { name: "Fix text, 3 words" });
    await expect(field).toHaveValue("small room can");
    await userEvent.keyboard("tiny studio{Enter}");
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "2 words selected: tiny studio",
    );
    await expect(
      canvas.getByRole("button", { name: "tiny (selected)" }),
    ).toHaveFocus();
    await expect(canvas.getByRole("button", { name: "sound" })).toBeVisible();
  },
};

function SpeakerChange({ args }: { args: ScriptPaneProps }) {
  const [turns, setTurns] = useState<readonly ScriptTurn[]>(args.turns);
  const [open, setOpen] = useState<string | null>(null);
  const turn = turns.find((t) => t.id === open);
  const { pane } = useLiveScript({ ...args, turns });
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-5)" }}>
      <div style={scriptFrame("25rem")}>
        <ScriptPane
          {...pane}
          onSpeaker={(turnId) => setOpen(turnId)}
          onSeekTurn={fn()}
        />
      </div>
      {turn ? (
        <SpeakerPopover
          people={PEOPLE}
          currentId={turn.speakerId}
          onClose={() => setOpen(null)}
          onPick={(id) => {
            const person = PEOPLE.find((p) => p.id === id);
            if (!person) return;
            setTurns(
              turns.map((t) =>
                t.id === turn.id ? { ...t, speakerId: id, speaker: person } : t,
              ),
            );
            setOpen(null);
          }}
          onRename={fn()}
        />
      ) : null}
    </div>
  );
}

export const SpeakerChangeByKeyboard: Story = {
  render: (args) => <SpeakerChange args={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByRole("button", { name: "Thanks" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect(
      canvas.getByRole("button", { name: "Anneke de Vries, change speaker" }),
    ).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await canvas.findByRole("radio", { name: /^Maya/ }));
    await expect(
      canvas.getByRole("group", { name: "Maya, 12:19" }),
    ).toBeVisible();
  },
};
