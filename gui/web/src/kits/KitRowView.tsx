import { useState } from "react";
import { isDamagedKit, type KitListRow, type KitRow } from "../api";
import { SystemIcon } from "../system/SystemIcon";
import { Menu, MenuItem, Pill } from "../ui";
import { entryCount, kitVersionTag } from "./kitFormat";

export const DAMAGED_CHIP = "Can't be read";
export const UNUSABLE_CHIP = "Can't be added to an episode yet";

type Props = {
  row: KitListRow;
  onExport: (row: KitRow) => void;
};

function RowMenu({
  row,
  onExport,
}: {
  row: KitRow;
  onExport: Props["onExport"];
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label={`Actions for ${row.name}`}
      className="ui-menu-root sys-menu"
      trigger={(props) => (
        <button
          type="button"
          className="kit-more"
          aria-label={`More actions for ${row.name}`}
          data-kit-more={row.id}
          {...props}
        >
          <SystemIcon name="ellipsis" size={16} />
        </button>
      )}
    >
      <MenuItem
        onSelect={() => {
          setOpen(false);
          onExport(row);
        }}
      >
        <SystemIcon name="download" size={16} />
        Export as file
      </MenuItem>
    </Menu>
  );
}

export function KitRowView({ row, onExport }: Props) {
  if (isDamagedKit(row)) {
    return (
      <li className="kit-row" data-kit-row={row.id} data-damaged>
        <span className="kit-warn">
          <SystemIcon name="triangle-alert" size={16} />
        </span>
        <div className="kit-main">
          <span className="kit-name kit-name--id">{row.id}</span>
          <Pill tone="warning">{DAMAGED_CHIP}</Pill>
          <span className="kit-problem">{row.problem}</span>
        </div>
      </li>
    );
  }
  return (
    <li
      className="kit-row"
      data-kit-row={row.id}
      data-unusable={!row.usable || undefined}
    >
      <div className="kit-main">
        <span className="kit-name">{row.name}</span>
        <span className="kit-tag">{kitVersionTag(row)}</span>
        <span className="kit-meta">
          <span className="kit-count">{entryCount(row)}</span>
          {row.usable ? null : <Pill tone="warning">{UNUSABLE_CHIP}</Pill>}
        </span>
        {row.usable || !row.problem ? null : (
          <span className="kit-problem">{row.problem}</span>
        )}
      </div>
      <RowMenu row={row} onExport={onExport} />
    </li>
  );
}
