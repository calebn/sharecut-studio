import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useState,
} from "react";
import { expect, fn, within } from "storybook/test";
import {
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { ActionBar, SelectionCount } from "../../system/ActionBar";
import { ScriptPane, type ScriptPaneProps } from "../../system/ScriptPane";
import {
  patchWords,
  SCRIPT_TURNS,
  spanPatch,
} from "../../system/scriptFixtures";

const meta: Meta<typeof ScriptPane> = {
  title: "Stages/Edit/ScriptPane",
  component: ScriptPane,
  args: {
    turns: SCRIPT_TURNS,
    onWord: fn(),
    onSeamSelect: fn(),
    onSuggestionSelect: fn(),
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
          "The Script pane in the Edit stage: the System pane with the Action bar over a selection, at the 400 px split width and on a phone with the dock. The pane is a view; these stories wire only what the composition needs.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ScriptPane>;

const stage = (width: string): CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  inlineSize: width,
  maxInlineSize: "100%",
  blockSize: "36rem",
  maxBlockSize: "100dvh",
  border: "1px solid var(--color-border)",
});

function useSelectionAnchor(): [
  (host: HTMLDivElement | null) => void,
  RefObject<HTMLElement | null> | null,
] {
  const [anchor, setAnchor] = useState<RefObject<HTMLElement | null> | null>(
    null,
  );
  const host = useCallback((el: HTMLDivElement | null) => {
    const target = el?.querySelector<HTMLElement>("[data-selected]") ?? null;
    setAnchor(target ? { current: target } : null);
  }, []);
  return [host, anchor];
}

const WORD_VERBS = [
  { id: "hear" },
  { id: "comment" },
  { id: "fixText" },
] as const;

function Split(args: ScriptPaneProps) {
  const [host, anchor] = useSelectionAnchor();
  return (
    <div ref={host} style={stage("25rem")}>
      <ScriptPane {...args} />
      {anchor ? (
        <ActionBar
          placement={{ form: "floating", anchorRef: anchor }}
          leading={<SelectionCount count={3} />}
          items={WORD_VERBS}
          primary={{ id: "cut" }}
          onVerb={fn()}
        />
      ) : null}
    </div>
  );
}

export const WithActionBar: Story = {
  render: (args) => <Split {...args} />,
  args: { selection: { start: 12, end: 14 }, playing: 3 },
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
  },
};

export const CutsAndSuggestions: Story = {
  render: (args) => (
    <div style={stage("25rem")}>
      <ScriptPane {...args} />
    </div>
  ),
  args: {
    playing: 22,
    selectedCut: 46,
    turns: patchWords(SCRIPT_TURNS, {
      ...spanPatch(46, 48, { state: "cut" }),
      ...spanPatch(31, 33, { state: "suggested" }),
      ...spanPatch(12, 13, { state: "muted" }),
      26: { lowConfidence: true },
      37: { lowConfidence: true },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Cut, 0.9 s removed" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.getByRole("button", { name: "? 2 unsure words, go to the next" }),
    ).toBeVisible();
  },
};

function Dock(args: ScriptPaneProps) {
  return (
    <div style={stage("22.5rem")}>
      <ScriptPane {...args} layout="phone" />
      <ActionBar
        placement={{ form: "dock" }}
        items={WORD_VERBS}
        primary={{ id: "cut" }}
        onVerb={fn()}
      />
    </div>
  );
}

export const PhoneWithDock: Story = {
  render: (args) => <Dock {...args} />,
  args: { selection: { start: 12, end: 14 }, playing: 3 },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Cut" }),
    ).toBeVisible();
  },
};
