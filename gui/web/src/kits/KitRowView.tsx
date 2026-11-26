import { useState } from "react";
import { isDamagedKit, type KitListRow, type KitRow } from "../api";
import { SystemIcon } from "../system/SystemIcon";
import { Menu, MenuItem, Pill } from "../ui";
import { entryCount, kitVersionTag } from "./kitFormat";

export const DAMAGED_CHIP = "Can't be read";
export const UNUSABLE_CHIP = "Can't be added to an episode yet";
export const DAMAGED_NAME = "Unreadable kit";
export const MISSING_NOTE =
  "It can't be exported until its segments are back in the library.";

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
          <span className="kit-name">{DAMAGED_NAME}</span>
          <span className="kit-tag kit-name--id">{row.id}</span>
          <Pill tone="warning">{DAMAGED_CHIP}</Pill>
          <span className="kit-problem">{row.problem}</span>
        </div>
      </li>
    );
  }
  // The server refuses to export a kit with a segment missing (409 kit_segment_missing).
  const exportable = row.missing === 0;
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
        {exportable ? null : (
          <span className="kit-problem">{MISSING_NOTE}</span>
        )}
      </div>
      {exportable ? <RowMenu row={row} onExport={onExport} /> : null}
    </li>
  );
}
