import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import {
  isolatedStoryParameters,
  menuStoryDecorator,
  portaledOverlayParameters,
} from "../storybook/storyLayout";
import { DialogLauncher } from "../test/DialogLauncher";
import { openDialogByLauncher } from "../test/storyDialog";
import { Button, Menu, MenuItem, MenuSection, MenuSeparator } from "../ui";
import type { SystemIconName } from "./icons";
import { Sheet } from "./Sheet";
import { SystemIcon } from "./SystemIcon";
import { capsOf, verbOf } from "./verbDisplay";
import type { VerbId } from "./verbs";

const meta: Meta<typeof Menu> = {
  title: "System/Menu",
  component: Menu,
  tags: ["autodocs"],
  decorators: [menuStoryDecorator],
  parameters: {
    ...isolatedStoryParameters,
    ...portaledOverlayParameters,
    docs: {
      ...isolatedStoryParameters.docs,
      description: {
        component:
          "A 280 px list of 36 px rows (44 on touch): verb icon, label, key caps. A header row names the anchor. Rows that cannot apply are absent. Wraps `ui/Menu`; the phone form is the same rows in a content-height Sheet.\n\n**Motion.** The panel drops in with `--motion-hover` through `ui/Menu`. Nothing else animates.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Menu>;

function VerbRow({
  verb,
  onSelect,
  icon,
}: {
  verb: VerbId;
  onSelect: () => void;
  icon?: SystemIconName;
}) {
  const def = verbOf(verb);
  const glyph = icon ?? def.icon;
  return (
    <MenuItem
      onSelect={onSelect}
      shortcut={def.keys[0] ? capsOf(def.keys[0]).join(" ") : undefined}
    >
      {glyph ? <SystemIcon name={glyph} size={16} /> : null}
      {def.label}
    </MenuItem>
  );
}

function Demo({
  label,
  trigger,
  children,
}: {
  label: string;
  trigger: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label={label}
      className="ui-menu-root sys-menu"
      trigger={(props) => <Button {...props}>{trigger}</Button>}
    >
      {children(close)}
    </Menu>
  );
}

async function openMenu(canvasElement: HTMLElement, name: string) {
  await userEvent.click(within(canvasElement).getByRole("button", { name }));
  await expect(await within(document.body).findByRole("menu")).toBeVisible();
}

export const Project: Story = {
  render: () => (
    <Demo label="Project menu" trigger="Episode 14">
      {(close) => (
        <>
          <VerbRow verb="fixText" onSelect={close} />
          <MenuSection label="Recent">
            <MenuItem onSelect={close}>Episode 13</MenuItem>
            <MenuItem onSelect={close}>Pilot cut</MenuItem>
          </MenuSection>
          <MenuSeparator />
          <MenuItem onSelect={close}>All projects</MenuItem>
          <MenuItem onSelect={close}>Settings</MenuItem>
          <MenuItem onSelect={close}>Connect agent</MenuItem>
          <MenuItem onSelect={close}>Help</MenuItem>
        </>
      )}
    </Demo>
  ),
  play: ({ canvasElement }) => openMenu(canvasElement, "Episode 14"),
};

export const More: Story = {
  render: () => (
    <Demo label="More" trigger="More">
      {(close) => (
        <>
          <VerbRow verb="split" onSelect={close} />
          <VerbRow verb="mute" onSelect={close} />
          <VerbRow verb="solo" onSelect={close} />
          <VerbRow verb="inspect" onSelect={close} />
          <VerbRow verb="remove" onSelect={close} />
        </>
      )}
    </Demo>
  ),
  play: ({ canvasElement }) => openMenu(canvasElement, "More"),
};

export const CreateHere: Story = {
  render: () => (
    <Demo label="Create here" trigger="Create here">
      {(close) => (
        <>
          <div className="sys-menu-anchor" aria-hidden="true">
            12:04.3 · Maya
          </div>
          <VerbRow verb="comment" onSelect={close} />
          <VerbRow verb="addChapter" onSelect={close} />
          <VerbRow verb="record" onSelect={close} />
          <VerbRow verb="import" onSelect={close} />
        </>
      )}
    </Demo>
  ),
  play: ({ canvasElement }) => openMenu(canvasElement, "Create here"),
};

export const Phone: Story = {
  decorators: [],
  render: () => (
    <DialogLauncher label="Create here" initiallyOpen={false}>
      {(open, close) => (
        <Sheet form="bottom" title="12:04.3 · Maya" open={open} onClose={close}>
          {(["comment", "addChapter", "record", "import"] as const).map(
            (id) => {
              const def = verbOf(id);
              return (
                <button
                  key={id}
                  type="button"
                  className="sys-row-btn"
                  onClick={close}
                >
                  <span className="sys-row-label">
                    {def.icon ? <SystemIcon name={def.icon} size={16} /> : null}
                    {def.label}
                  </span>
                </button>
              );
            },
          )}
        </Sheet>
      )}
    </DialogLauncher>
  ),
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    await openDialogByLauncher(canvasElement, {
      launcherName: "Create here",
      dialogName: "12:04.3 · Maya",
    });
  },
};
