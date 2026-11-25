import { useEffect, useState } from "react";
import {
  type DamagedSegmentRow,
  isDamagedSegment,
  type SegmentListRow,
  type SegmentRow,
} from "../api";
import { SystemIcon } from "../system/SystemIcon";
import {
  InlineConfirm,
  Menu,
  MenuItem,
  Pill,
  registerInlineConfirm,
} from "../ui";
import { formatTimeShort } from "../utils/time";
import { KIND_LABEL, segmentLengthSec, versionTag } from "./format";

export type RowLayout = "table" | "list";

export type RowHandlers = {
  playingId: string | null;
  failedId: string | null;
  confirmId: string | null;
  removingId: string | null;
  onToggle: (row: SegmentRow) => void;
  onAskRemove: (row: SegmentListRow) => void;
  onKeep: (id: string) => void;
  onConfirm: (row: SegmentListRow) => void;
};

type RowProps = RowHandlers & {
  row: SegmentListRow;
  layout: RowLayout;
};

export const DAMAGED_CHIP = "Can't be played or inserted";
export const PLAY_FAILED = "Couldn't play this segment";

function rowName(row: SegmentListRow): string {
  return isDamagedSegment(row) ? row.id : row.name;
}

function removePrompt(row: SegmentListRow): string {
  if (isDamagedSegment(row)) {
    return `Remove ${row.id} from the library? This removes every version of it and can't be undone.`;
  }
  const versions =
    row.versions.length > 1 ? `all ${row.versions.length} versions` : "it";
  return `Remove “${row.name}” from the library? This removes ${versions} and can't be undone. Episodes that already use it keep their copy.`;
}

function PlayButton({
  row,
  playing,
  onToggle,
}: {
  row: SegmentRow;
  playing: boolean;
  onToggle: (row: SegmentRow) => void;
}) {
  return (
    <button
      type="button"
      className="segment-play"
      aria-label={`${playing ? "Stop" : "Play"} ${row.name}`}
      data-playing={playing || undefined}
      data-segment-focus
      onClick={() => onToggle(row)}
    >
      <SystemIcon name={playing ? "square" : "play"} size={16} />
    </button>
  );
}

function RowMenu({
  row,
  onAskRemove,
  focusMark,
}: {
  row: SegmentListRow;
  onAskRemove: (row: SegmentListRow) => void;
  focusMark: boolean;
}) {
  const [open, setOpen] = useState(false);
  const name = rowName(row);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label={`Actions for ${name}`}
      className="ui-menu-root sys-menu"
      trigger={(props) => (
        <button
          type="button"
          className="segment-more"
          aria-label={`More actions for ${name}`}
          data-segment-more={row.id}
          data-segment-focus={focusMark || undefined}
          {...props}
        >
          <SystemIcon name="ellipsis" size={16} />
        </button>
      )}
    >
      <MenuItem
        onSelect={() => {
          setOpen(false);
          onAskRemove(row);
        }}
      >
        <SystemIcon name="trash-2" size={16} />
        Remove from library
      </MenuItem>
    </Menu>
  );
}

function Confirm({
  row,
  removing,
  onKeep,
  onConfirm,
}: {
  row: SegmentListRow;
  removing: boolean;
  onKeep: (id: string) => void;
  onConfirm: (row: SegmentListRow) => void;
}) {
  useEffect(() => {
    if (!removing) return;
    return registerInlineConfirm(() => {});
  }, [removing]);
  return (
    <div
      role="presentation"
      aria-busy={removing || undefined}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (!removing) onKeep(row.id);
      }}
    >
      <InlineConfirm
        prompt={removePrompt(row)}
        keepLabel="Keep"
        actionLabel="Remove"
        disabledReason={removing ? "Removing…" : undefined}
        onKeep={() => onKeep(row.id)}
        onConfirm={() => onConfirm(row)}
      />
    </div>
  );
}

function Problem({ row }: { row: DamagedSegmentRow }) {
  return (
    <>
      <span className="segment-name segment-name--id">{row.id}</span>
      <Pill tone="warning">{DAMAGED_CHIP}</Pill>
      <span className="segment-problem">{row.problem}</span>
    </>
  );
}

function Healthy({ row, failed }: { row: SegmentRow; failed: boolean }) {
  return (
    <>
      <span className="segment-name">{row.name}</span>
      <span className="segment-tag">{versionTag(row)}</span>
      {failed ? <span className="segment-failed">{PLAY_FAILED}</span> : null}
    </>
  );
}

export function SegmentRowView(props: RowProps) {
  const { row, layout, playingId, failedId, confirmId, removingId } = props;
  const damaged = isDamagedSegment(row);
  const confirming = confirmId === row.id;
  const removing = removingId === row.id;
  const Row = layout === "table" ? "tr" : "li";
  if (confirming) {
    const confirm = (
      <Confirm
        row={row}
        removing={removing}
        onKeep={props.onKeep}
        onConfirm={props.onConfirm}
      />
    );
    return layout === "table" ? (
      <tr
        className="segment-row segment-row--confirm"
        data-segment-row={row.id}
      >
        <td colSpan={5}>{confirm}</td>
      </tr>
    ) : (
      <li
        className="segment-row segment-row--confirm"
        data-segment-row={row.id}
      >
        {confirm}
      </li>
    );
  }
  const lead = damaged ? (
    <span className="segment-warn">
      <SystemIcon name="triangle-alert" size={16} />
    </span>
  ) : (
    <PlayButton
      row={row}
      playing={playingId === row.id}
      onToggle={props.onToggle}
    />
  );
  const menu = (
    <RowMenu row={row} onAskRemove={props.onAskRemove} focusMark={damaged} />
  );
  if (layout === "table") {
    return (
      <Row
        className="segment-row"
        data-segment-row={row.id}
        data-damaged={damaged || undefined}
      >
        <td className="segment-cell-lead">{lead}</td>
        {damaged ? (
          <th scope="row" colSpan={3} className="segment-cell-name">
            <Problem row={row} />
          </th>
        ) : (
          <>
            <th scope="row" className="segment-cell-name">
              <Healthy row={row} failed={failedId === row.id} />
            </th>
            <td className="segment-cell-kind">
              <Pill>{KIND_LABEL[row.kind] ?? KIND_LABEL.other}</Pill>
            </td>
            <td className="segment-cell-length">
              {formatTimeShort(segmentLengthSec(row))}
            </td>
          </>
        )}
        <td className="segment-cell-more">{menu}</td>
      </Row>
    );
  }
  return (
    <Row
      className="segment-row"
      data-segment-row={row.id}
      data-damaged={damaged || undefined}
    >
      {lead}
      <div className="segment-main">
        {damaged ? (
          <Problem row={row} />
        ) : (
          <>
            <Healthy row={row} failed={failedId === row.id} />
            <span className="segment-meta">
              <Pill>{KIND_LABEL[row.kind] ?? KIND_LABEL.other}</Pill>
              <span className="segment-length">
                {formatTimeShort(segmentLengthSec(row))}
              </span>
            </span>
          </>
        )}
      </div>
      {menu}
    </Row>
  );
}
