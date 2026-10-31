import {
  type FocusEvent,
  Fragment,
  memo,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Sheet } from "../../system/Sheet";
import { SystemIcon } from "../../system/SystemIcon";
import { MenuItem } from "../../ui";
import { useMenuKeyboard } from "../../ui/useMenuKeyboard";
import { useStableCallback } from "../../utils/useStableCallback";
import {
  type Bounds,
  layoutMenu,
  type MenuSize,
  naturalSize,
  type Point,
} from "./createMenuLayout";
import {
  type CreateRow,
  type CreateRowId,
  rowKeyShortcuts,
  rowShortcut,
} from "./createMenuRows";

/**
 * The attribute the timeline's hit router reads to find a row under a sliding
 * finger (`CREATE_ITEM_ATTR` in `timeline/hitRouting.ts`, which this part does
 * not import; a test pins the two together). Its value is the row's index.
 */
export const CREATE_ITEM_ATTR = "data-create-item";

export type CreateMenuProps = {
  /** The rows the held point offers; absent rows are simply not in the list. */
  rows: readonly CreateRow[];
  /** The held time, formatted ("12:04.3"). */
  time: string;
  /** The held lane's name, or null off a lane. */
  track: string | null;
  /** The held point, in the positioned box the leaf is mounted in. */
  anchor: Point;
  /** The box the menu stays inside, in the same coordinates. */
  bounds: Bounds;
  /** The room used when the menu is taller than `bounds`; defaults to `bounds`. */
  viewport?: Bounds;
  /** The fixed playhead's x on a phone, which the menu sits beside. */
  avoidX?: number | null;
  /**
   * The row index a sliding finger is over, or null. The popover form only:
   * the phone Sheet is modal and its rows are plain buttons, so `over` is
   * ignored there (no row is highlighted under a sliding finger).
   */
  over?: number | null;
  /** The held lane's top and bottom, for the dashed time mark. */
  mark?: { top: number; bottom: number } | null;
  /** The phone form: the same rows in a content-height bottom Sheet. */
  phone?: boolean;
  onPick: (id: CreateRowId) => void;
  onClose: () => void;
};

type PopoverProps = Omit<CreateMenuProps, "phone"> & { title: string };

/**
 * The menu in its box. Its size is read once, when it mounts: `CreateMenu`
 * keys it by its rows and title, so a change of either measures it again.
 */
function Popover({
  rows,
  title,
  anchor,
  bounds,
  viewport,
  avoidX = null,
  over = null,
  mark = null,
  onPick,
  onClose,
}: PopoverProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<MenuSize | null>(null);
  const close = useStableCallback(() => onClose());
  useMenuKeyboard({ open: true, panelRef: boxRef, close });
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box) setSize(naturalSize(box));
  }, []);

  const leave = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    close();
  };
  const layout = size
    ? layoutMenu(anchor, bounds, size, avoidX, viewport ?? bounds)
    : {
        placement: "above" as const,
        left: anchor.x,
        top: anchor.y,
        maxHeight: null,
      };
  return (
    <div className="edit-create-layer">
      <svg className="edit-create-mark" aria-hidden="true" focusable="false">
        {mark ? (
          <line x1={anchor.x} x2={anchor.x} y1={mark.top} y2={mark.bottom} />
        ) : null}
        <circle cx={anchor.x} cy={anchor.y} r="6" />
      </svg>
      <div
        ref={boxRef}
        role="menu"
        aria-label={`Create at ${title}`}
        tabIndex={-1}
        className="ui-menu-panel edit-create-menu"
        data-placement={layout.placement}
        data-scrolls={
          layout.maxHeight != null && size && size.height > layout.maxHeight
            ? ""
            : undefined
        }
        style={{
          left: layout.left,
          top: layout.top,
          maxBlockSize: layout.maxHeight ?? undefined,
          visibility: size ? "visible" : "hidden",
        }}
        onBlur={leave}
      >
        <p className="edit-create-menu-title" aria-hidden="true">
          {title}
        </p>
        {rows.map((row, index) => (
          <Fragment key={row.id}>
            {row.startsGroup ? (
              <hr className="edit-create-menu-separator" />
            ) : null}
            <MenuItem
              over={over === index}
              dataAttrs={{ [CREATE_ITEM_ATTR]: String(index) }}
              shortcut={rowShortcut(row)}
              keyShortcuts={rowKeyShortcuts(row)}
              ariaDescription={row.note}
              onSelect={() => onPick(row.id)}
            >
              <SystemIcon name={row.icon} size={16} />
              {row.label}
            </MenuItem>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/**
 * The Create here menu (spec-edit MENU-CREATE): a 220 px menu headed by the
 * held time and track ("12:04.3 · Maya") over the rows its point offers. A
 * leaf view on plain data: it reads no store and runs no command, so the host
 * maps `onPick(id)` to commands with the held time and closes the menu.
 *
 * It is positioned inside the box it is mounted in (`position: absolute`, no
 * portal, no top layer): the wiring host adds those. The gesture belongs to the
 * hit router, which reports the row under the finger as `over` and calls
 * `onPick`; the keyboard belongs to `useMenuKeyboard`. A Tab out of the menu
 * closes it, so the keymap is never held shut behind a menu that has lost its
 * focus.
 *
 * The leaf owns no live region: the host announces the menu ("Create at
 * 12:04.3 on Maya, 4 actions"), as design-system.md MENU-CREATE wiring item 3
 * records.
 */
function CreateMenuView({ phone = false, ...props }: CreateMenuProps) {
  const { rows, time, track, onPick, onClose } = props;
  const sheetId = useId();
  const title = track ? `${time} · ${track}` : time;
  if (phone) {
    return (
      <Sheet form="bottom" detent="fit" title={title} onClose={onClose}>
        {rows.map((row, index) => (
          <Fragment key={row.id}>
            <button
              type="button"
              className="sys-row-btn"
              {...{ [CREATE_ITEM_ATTR]: String(index) }}
              title={row.note}
              aria-describedby={row.note ? `${sheetId}-${row.id}` : undefined}
              onClick={() => onPick(row.id)}
            >
              <span className="sys-row-label">
                <SystemIcon name={row.icon} size={16} />
                {row.label}
              </span>
            </button>
            {row.note ? (
              <span
                id={`${sheetId}-${row.id}`}
                className="sr-only"
                aria-hidden="true"
              >
                {row.note}
              </span>
            ) : null}
          </Fragment>
        ))}
      </Sheet>
    );
  }
  const shape = `${title}|${rows.map((row) => row.id).join()}`;
  return <Popover key={shape} {...props} title={title} />;
}

export const CreateMenu = memo(CreateMenuView);
