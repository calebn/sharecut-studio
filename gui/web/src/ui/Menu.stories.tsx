import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { menuStoryDecorator } from "../storybook/storyLayout";
import { Button, Menu, MenuItem, MenuSection } from "./index";

const meta: Meta<typeof Menu> = {
  title: "Molecules/Menu",
  component: Menu,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [menuStoryDecorator],
};

export default meta;
type Story = StoryObj<typeof Menu>;

function DemoMenu() {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label="Clip actions"
      trigger={(props) => <Button {...props}>Actions</Button>}
    >
      <MenuSection label="Edit">
        <MenuItem onSelect={() => setOpen(false)}>Split at playhead</MenuItem>
        <MenuItem onSelect={() => setOpen(false)}>Duplicate</MenuItem>
      </MenuSection>
      <MenuSection label="Danger">
        <MenuItem onSelect={() => setOpen(false)} className="danger">
          Delete clip
        </MenuItem>
        <MenuItem disabled>Disabled action</MenuItem>
      </MenuSection>
    </Menu>
  );
}

export const Default: Story = { render: () => <DemoMenu /> };

export const Open: Story = {
  render: () => <DemoMenu />,
  play: async ({ canvasElement }) => {
    const trigger = canvasElement.querySelector("button");
    trigger?.click();
  },
};

function ShortcutMenu() {
  // Starts closed: an open Menu listens on window and would take over the
  // autodocs page's keys and scroll. The play function opens it.
  const [open, setOpen] = useState(false);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label="Project menu"
      trigger={(props) => <Button {...props}>Menu</Button>}
    >
      <MenuSection label="Project">
        <MenuItem shortcut="⌘N" onSelect={() => setOpen(false)}>
          New project…
        </MenuItem>
        <MenuItem shortcut="⌘O" onSelect={() => setOpen(false)}>
          Open project…
        </MenuItem>
        <MenuItem onSelect={() => setOpen(false)}>Share…</MenuItem>
      </MenuSection>
      <MenuSection label="Help">
        <MenuItem shortcut="?" onSelect={() => setOpen(false)}>
          Commands and shortcuts
        </MenuItem>
      </MenuSection>
    </Menu>
  );
}

/** Section labels and right-aligned shortcuts; shortcuts stay out of the accessible name. */
export const WithShortcuts: Story = {
  render: () => <ShortcutMenu />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Menu" }));
    const item = await canvas.findByRole("menuitem", { name: /New project/ });
    await expect(item.querySelector("kbd[aria-hidden='true']")).toBeTruthy();
  },
};
