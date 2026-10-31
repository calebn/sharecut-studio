import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, within } from "storybook/test";
import {
  isolatedStoryParameters,
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { Measured } from "../../system/laneStoryHost";
import { DialogLauncher } from "../../test/DialogLauncher";
import { openDialogByLauncher } from "../../test/storyDialog";
import { Button } from "../../ui";
import { CreateMenu } from "./CreateMenu";
import {
  type CreateFacts,
  type CreateRowId,
  createMenuRows,
} from "./createMenuRows";

const BOX_HEIGHT = 320;
const LANE = { top: 216, bottom: 296 };
const FACTS: CreateFacts = {
  lane: true,
  envelopeShown: true,
  clipboardHasAudio: false,
};
const PICKED: Record<CreateRowId, string> = {
  split: "Split here",
  comment: "Comment here",
  addChapter: "Add chapter here",
  addVolumePoint: "Add volume point",
  paste: "Paste",
};

type DemoProps = {
  facts?: CreateFacts;
  /** The held point; a negative x counts from the box's right edge. */
  at: { x: number; y: number };
};

const box = {
  position: "relative",
  boxSizing: "border-box",
  inlineSize: "100%",
  blockSize: BOX_HEIGHT,
  overflow: "hidden",
  background: "var(--color-bg-canvas)",
  border: "1px solid var(--color-border)",
} as const;

const lane = {
  position: "absolute",
  inset: `${LANE.top}px 0 auto 0`,
  blockSize: LANE.bottom - LANE.top,
  background: "var(--color-timeline-lane)",
} as const;

/** The positioned box the leaf is mounted in, and the open state a host would keep. */
function Demo({ facts = FACTS, at }: DemoProps) {
  const [open, setOpen] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const rows = createMenuRows(facts);
  return (
    <div style={{ padding: "var(--space-4)" }}>
      <Measured>
        {(measured) => {
          // The box has a 1 px border on each side.
          const width = measured - 2;
          return (
            <div style={box}>
              <div style={lane} />
              {open ? (
                <CreateMenu
                  rows={rows}
                  time="12:04.3"
                  track={facts.lane ? "Maya" : null}
                  anchor={{ x: at.x < 0 ? width + at.x : at.x, y: at.y }}
                  bounds={{ left: 0, top: 0, right: width, bottom: BOX_HEIGHT }}
                  mark={facts.lane ? LANE : null}
                  onPick={(id) => {
                    setPicked(PICKED[id]);
                    setOpen(false);
                  }}
                  onClose={() => setOpen(false)}
                />
              ) : null}
            </div>
          );
        }}
      </Measured>
      <p aria-live="polite">{picked ? `Picked: ${picked}` : ""}</p>
      {open ? null : (
        <Button onClick={() => setOpen(true)}>Open the menu again</Button>
      )}
    </div>
  );
}

const meta: Meta<typeof Demo> = {
  title: "Stages/Edit/CreateMenu",
  component: Demo,
  tags: ["autodocs"],
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          'The Create here menu (spec-edit MENU-CREATE; an Edit-local instance of design-system element 10): a 220 px menu for a right-click, Shift+F10 or a long-press on an empty point. It is headed "12:04.3 · Maya" (32 px) and lists Split here (S, Mod+K), Comment here (C), Add chapter here (Shift+C), Add volume point (on a lane, while its envelope shows) and Paste (only when the clipboard has audio). A row that cannot apply is absent: there are no disabled rows and no reasons. Rows are 36 px, 44 px under a coarse pointer, with the Action bar\'s icons, and the first chord of a verb as key caps.\n\nThe leaf is plain data: `rows` (from `createMenuRows`), `time`, `track`, `anchor`, `bounds`, `onPick(id)` and `onClose()`. It reads no store and runs no command; the wiring host maps `onPick(id)` to commands at the held time and closes the menu. Split here is the held-time form (the legacy `edit.bladeCut` with `atTime`), not the playhead\'s `edit.split`. A dashed line marks the held time on its lane (`mark`).\n\nIt is positioned inside the box it is mounted in, never over the point: above it, else below, else beside, 24 px away and 16 px from the box\'s edges (`avoidX` keeps clear of a phone\'s fixed playhead). A menu taller than any room is capped and scrolls. There is no portal, top layer or fixed position here; the host adds those.\n\n**Keys.** Up, Down, Home and End move between rows and Escape closes (`useMenuKeyboard`, the only window listener); while the menu is open the keymap holds every key, so Escape does not also clear the selection. Tab out of the menu closes it. A row has `role="menuitem"` and `aria-keyshortcuts`, and carries `data-create-item` (its index) for the timeline\'s hit router, which reports the row under a sliding finger as `over`. The host announces "Create at 12:04.3 on Maya, 4 actions".\n\n**Phone.** The same rows in a content-height bottom Sheet (`detent="fit"`).\n\n**Motion.** The panel drops in with `--motion-hover`, as every menu; reduced motion turns it off.',
      },
    },
  },
  args: { at: { x: 240, y: 268 } },
};

export default meta;
type Story = StoryObj<typeof Demo>;

export const Lane: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const menu = await canvas.findByRole("menu", {
      name: "Create at 12:04.3 · Maya",
    });
    await expect(menu).toBeVisible();
    await expect(
      canvas.getAllByRole("menuitem").map((el) => el.textContent),
    ).toEqual([
      "Split hereS",
      "Comment hereC",
      "Add chapter here⇧ C",
      "Add volume point",
    ]);
  },
};

export const WithPaste: Story = {
  args: { facts: { ...FACTS, clipboardHasAudio: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("menuitem", { name: "Paste" }),
    ).toBeVisible();
    await expect(canvas.getAllByRole("menuitem")).toHaveLength(5);
  },
};

export const NearEdge: Story = {
  args: { at: { x: -10, y: 40 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The jsdom run has no layout; the flip below the point and the 16 px
    // gutter at the side edge are measured in e2e-storybook/edit-popovers.spec.ts.
    await expect(await canvas.findByRole("menu")).toBeVisible();
    await expect(canvas.getAllByRole("menuitem")).toHaveLength(4);
  },
};

export const Phone: Story = {
  parameters: isolatedStoryParameters,
  render: () => (
    <DialogLauncher label="Create here" initiallyOpen={false}>
      {(open, close) =>
        open ? (
          <CreateMenu
            rows={createMenuRows({ ...FACTS, clipboardHasAudio: true })}
            time="12:04.3"
            track="Maya"
            anchor={{ x: 0, y: 0 }}
            bounds={{ left: 0, top: 0, right: 0, bottom: 0 }}
            phone
            onPick={close}
            onClose={close}
          />
        ) : null
      }
    </DialogLauncher>
  ),
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialogByLauncher(canvasElement, {
      launcherName: "Create here",
      dialogName: "12:04.3 · Maya",
    });
    await expect(
      within(dialog).getAllByRole("button", { name: /here|volume|Paste/ }),
    ).toHaveLength(5);
  },
};
