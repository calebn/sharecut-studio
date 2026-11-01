import type { Meta, StoryObj } from "@storybook/react-vite";
import { type CSSProperties, useRef } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import type { EditRole } from "../edit/editSelection";
import { viewportStoryParameters } from "../storybook/storyLayout";
import {
  type BarScene,
  barScene,
  EDIT_SELECTIONS,
} from "../test/actionBarFixtures";
import type { Selection } from "../types/project";
import { ActionBar, type ActionBarProps, SelectionCount } from "./ActionBar";
import { ScopeChip } from "./ScopeChip";

const meta: Meta<typeof ActionBar> = {
  title: "System/ActionBar",
  component: ActionBar,
  tags: ["autodocs"],
  args: { onVerb: fn() },
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The one Action bar (design-system element 7) in three forms with one verb order: Scope chip, Hear and A/B, Keep, Split, Comment, Fix text, Record, Export, Remove, More, Inspect, then the primary at the trailing end. The **floating** pill (40 px, 44 on touch) hangs 8 px above its selection and flips below when there is no room. The **dock** is the phone's 64 px row: a 48 px icon over a 10 px label, five verb slots with the primary in the last, then More; verbs past the five fold into More in the same order. The grip on top is Inspect. The **inline** form is the same row inside a Decision card, and `ActionBarInline` wraps it. Verbs that do not apply are absent, never disabled; the stories below build each bar with `resolveBar`, so they show the verb table as it stands.\n\nStatus: the key hints show the target chords (C, Shift+Space, X) while their `verbs.ts` statuses are still `conflict`; wiring flips them. `RecordDock` is a fourth shape of this element and stays its own component until it converges. Review's dock stories stay with `ActionBarInline`.\n\n**Motion.** Animations come later: the floating pill fades in over `--motion-hover` and follows its selection without easing; the More menu drops in through `ui/Menu`. Nothing else animates.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ActionBar>;

const barNames = (root: HTMLElement) =>
  within(root)
    .getAllByRole("button")
    .filter((button) => !button.classList.contains("sys-scope"))
    .map((button) => button.getAttribute("aria-label") ?? button.textContent);

function leadingFor(scene: BarScene, ripple: boolean) {
  if (scene.resolved.leading === "scope")
    return <ScopeChip {...scene.scope} ripple={ripple} onToggle={fn()} />;
  if (scene.resolved.leading === "count")
    return <SelectionCount count={scene.count} />;
  return undefined;
}

type SceneProps = {
  selection: Selection;
  role?: EditRole;
  clipboardHasAudio?: boolean;
  ripple?: boolean;
  onVerb: ActionBarProps["onVerb"];
};

const stage: CSSProperties = {
  minBlockSize: "16rem",
  padding: "var(--space-5)",
  paddingBlockStart: "8rem",
};

const selected: CSSProperties = {
  inlineSize: "12rem",
  blockSize: "2rem",
  background: "var(--color-accent-subtle)",
  border: "var(--space-0) solid var(--color-accent)",
  borderRadius: "var(--radius-md)",
};

function FloatingScene({
  selection,
  role,
  clipboardHasAudio,
  ripple = true,
  onVerb,
}: SceneProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const scene = barScene(selection, { role, clipboardHasAudio });
  return (
    <div style={stage}>
      <div ref={anchorRef} style={selected} />
      <ActionBar
        placement={{ form: "floating", anchorRef }}
        leading={leadingFor(scene, ripple)}
        items={scene.items}
        more={scene.more}
        primary={scene.primary}
        onVerb={onVerb}
      />
    </div>
  );
}

function DockScene({
  selection,
  role,
  clipboardHasAudio,
  ripple = true,
  onVerb,
  width,
}: SceneProps & { width: string }) {
  const scene = barScene(selection, { role, clipboardHasAudio });
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        inlineSize: width,
        maxInlineSize: "100%",
        blockSize: "16rem",
      }}
    >
      <ActionBar
        placement={{ form: "dock" }}
        leading={leadingFor(scene, ripple)}
        items={scene.items}
        more={scene.more}
        primary={scene.primary}
        onVerb={onVerb}
      />
    </main>
  );
}

const floating = (
  selection: Selection,
  options: Partial<SceneProps> = {},
): Pick<Story, "render"> => ({
  render: (args) => (
    <FloatingScene selection={selection} onVerb={args.onVerb} {...options} />
  ),
});

const dock = (
  selection: Selection,
  width: string,
  options: Partial<SceneProps> = {},
): Pick<Story, "render"> => ({
  render: (args) => (
    <DockScene
      selection={selection}
      width={width}
      onVerb={args.onVerb}
      {...options}
    />
  ),
});

export const Words: Story = {
  ...floating(EDIT_SELECTIONS.liveWords),
  play: async ({ args, canvasElement }) => {
    await expect(barNames(canvasElement)).toEqual([
      "Hear",
      "Split",
      "Comment",
      "Fix text",
      "Record",
      "More",
      "Inspect",
      "Cut",
    ]);
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Hear" }),
    );
    await expect(args.onVerb).toHaveBeenLastCalledWith("hear");
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Cut" }),
    );
    await expect(args.onVerb).toHaveBeenLastCalledWith("cut");
  },
};

export const Range: Story = {
  ...floating(EDIT_SELECTIONS.rangeOnAllTracks),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("All")).toBeVisible();
    await expect(barNames(canvasElement)).toEqual([
      "Hear",
      "Split",
      "Comment",
      "Record",
      "Export",
      "More",
      "Inspect",
      "Cut",
    ]);
  },
};

export const RangeWithGap: Story = {
  ...floating(EDIT_SELECTIONS.rangeOverGap, { ripple: false }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("img", { name: "Leave gap" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "More" }));
    const menu = await within(canvasElement.ownerDocument.body).findByRole(
      "menu",
      { name: "More actions" },
    );
    await expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Mute", "Fill room tone", "Move to speaker", "Copy"]);
  },
};

export const Clip: Story = {
  ...floating(EDIT_SELECTIONS.clip),
  play: async ({ canvasElement }) => {
    await expect(barNames(canvasElement)).toEqual([
      "Hear",
      "Split",
      "Comment",
      "Cut",
      "More",
      "Inspect",
    ]);
    await expect(canvasElement.querySelector(".primary")).toBeNull();
  },
};

export const Seam: Story = {
  ...floating(EDIT_SELECTIONS.seam),
  play: async ({ canvasElement }) => {
    await expect(barNames(canvasElement)).toEqual([
      "Hear",
      "Keep",
      "Comment",
      "More",
      "Inspect",
    ]);
  },
};

export const Suggestion: Story = {
  ...floating(EDIT_SELECTIONS.suggestion),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("group", { name: "Hear before and after" }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Hear after" }));
    await expect(args.onVerb).toHaveBeenLastCalledWith("hearAfter");
    await expect(canvasElement.querySelectorAll(".primary")).toHaveLength(1);
  },
};

export const Comment: Story = {
  ...floating({ kind: "comment", id: "open" }),
  play: async ({ canvasElement }) => {
    await expect(barNames(canvasElement)).toEqual([
      "Comment",
      "Remove",
      "Inspect",
      "Resolve",
    ]);
  },
};

export const Multi: Story = {
  ...floating(EDIT_SELECTIONS.clips),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("3 selected"),
    ).toBeInTheDocument();
    await expect(barNames(canvasElement)).toEqual([
      "Hear",
      "Split",
      "Comment",
      "Cut",
      "More",
      "Inspect",
    ]);
  },
};

export const ReadOnly: Story = {
  ...floating(EDIT_SELECTIONS.cutWords, { role: "readOnly" }),
  play: async ({ canvasElement }) => {
    await expect(barNames(canvasElement)).toEqual(["Hear", "Comment"]);
    await expect(canvasElement.querySelector(".sys-scope")).toBeNull();
  },
};

const playDock = async ({
  args,
  canvasElement,
}: {
  args: { onVerb: ActionBarProps["onVerb"] };
  canvasElement: HTMLElement;
}) => {
  const canvas = within(canvasElement);
  await expect(barNames(canvasElement)).toEqual([
    "Inspect",
    "Hear",
    "Keep",
    "Split",
    "Comment",
    "More",
    "Cut",
  ]);
  await userEvent.click(canvas.getByRole("button", { name: "Inspect" }));
  await expect(args.onVerb).toHaveBeenLastCalledWith("inspect");
};

export const PhoneDock: Story = {
  ...dock(EDIT_SELECTIONS.cutWords, "22.5rem"),
  play: playDock,
};

export const PhoneDock390: Story = {
  name: "Phone Dock 390",
  ...dock(EDIT_SELECTIONS.cutWords, "24.375rem"),
  play: playDock,
};

const playPlayhead = async ({
  canvasElement,
}: {
  canvasElement: HTMLElement;
}) => {
  await expect(barNames(canvasElement)).toEqual([
    "Split",
    "Add chapter",
    "Record",
    "Paste",
  ]);
};

export const PhoneDockPlayhead: Story = {
  ...dock(EDIT_SELECTIONS.playhead, "22.5rem", { clipboardHasAudio: true }),
  play: playPlayhead,
};

export const PhoneDockPlayhead390: Story = {
  name: "Phone Dock Playhead 390",
  ...dock(EDIT_SELECTIONS.playhead, "24.375rem", { clipboardHasAudio: true }),
  play: playPlayhead,
};
