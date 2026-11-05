import { useState } from "react";
import { Button, Menu, MenuItem } from "../ui";
import { SystemIcon } from "./SystemIcon";

type Props = {
  id: string;
  name: string;
  onRemove: (id: string, name: string) => void;
};

/** The host's menu on another person's tile: today, take them out of the room. */
export function RoomTileMenu({ id, name, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  const label = `Options for ${name}`;
  return (
    <div className="sys-room-tile-menu">
      <Menu
        open={open}
        onOpenChange={setOpen}
        label={label}
        trigger={(props) => (
          <Button {...props} aria-label={label} title={label}>
            <SystemIcon name="ellipsis" size={16} />
          </Button>
        )}
      >
        <MenuItem
          onSelect={() => {
            setOpen(false);
            onRemove(id, name);
          }}
        >
          Remove from room
        </MenuItem>
      </Menu>
    </div>
  );
}
