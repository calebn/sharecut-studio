import {
  type FocusEvent,
  Fragment,
  memo,
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

/** The menu's width (spec-edit MENU-CREATE), in px; the style rule is 13.75rem. */
export const CREATE_MENU_WIDTH_PX = 220;

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
  /** The row index a sliding finger is over, or null. */
  over?: number | null;
  /** The held lane's top and bottom, for the dashed time mark. */
  mark?: { top: number; bottom: number } | null;
  /** The phone form: the same rows in a content-height bottom Sheet. */
  phone?: boolean;
  onPick: (id: CreateRowId) => void;
  onClose: () => void;
};

function sameSize(a: MenuSize | null, b: MenuSize): boolean {
  return a != null && a.width === b.width && a.height === b.height;
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
 */
function CreateMenuView({
  rows,
  time,
  track,
  anchor,
  bounds,
  viewport,
  avoidX = null,
  over = null,
  mark = null,
  phone = false,
  onPick,
  onClose,
}: CreateMenuProps) {
  const title = track ? `${time} · ${track}` : time;
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<MenuSize | null>(null);
  const close = useStableCallback(() => onClose());
  useMenuKeyboard({ open: !phone, panelRef: boxRef, close });

  // Measured after every render (a size that did not change sets nothing), so
  // a change of rows or title is placed at once.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const next = naturalSize(box);
    setSize((now) => (sameSize(now, next) ? now : next));
  });

  const leave = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    close();
  };

  if (phone) {
    return (
      <Sheet form="bottom" detent="fit" title={title} onClose={onClose}>
        {rows.map((row, index) => (
          <button
            key={row.id}
            type="button"
            className="sys-row-btn"
            {...{ [CREATE_ITEM_ATTR]: String(index) }}
            onClick={() => onPick(row.id)}
          >
            <span className="sys-row-label">
              <SystemIcon name={row.icon} size={16} />
              {row.label}
            </span>
          </button>
        ))}
      </Sheet>
    );
  }

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

export const CreateMenu = memo(CreateMenuView);
