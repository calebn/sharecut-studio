import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button, Menu, MenuItem, MenuSection } from "./index";

const meta: Meta<typeof Menu> = {
  title: "Molecules/Menu",
  component: Menu,
  tags: ["autodocs"],
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
