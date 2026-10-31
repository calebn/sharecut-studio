import { type CSSProperties, type FocusEvent, memo, useRef } from "react";
import { presenceColorVar } from "../../presence/colors";
import { SystemIcon } from "../../system/SystemIcon";
import { useMenuKeyboard } from "../../ui/useMenuKeyboard";
import { useStableCallback } from "../../utils/useStableCallback";
import {
  type ChooserKind,
  KIND_ICONS,
  KIND_NAMES,
  TARGET_ID_ATTR,
} from "./chooserKinds";
import { CHOOSER_MAX_CHIPS, layoutChips } from "./chooserMath";
import type { Bounds, Point } from "./createMenuLayout";

export type ChooserTarget = {
  /** Stable across pages; `over` and `onPick` speak in ids, never indices. */
  id: string;
  kind: ChooserKind;
  /** Picks the ring's colour from the eight presence colours. */
  trackColorIndex: number;
  /** The caption while the finger is over this chip. */
  label: string;
};

export type TargetChooserProps = {
  /** At most five are drawn, in this order (left to right); fewer than two draw nothing. */
  targets: readonly ChooserTarget[];
  /** The press point, in the positioned box the leaf is mounted in. */
  anchor: Point;
  /** The box the fan stays inside, in the same coordinates. */
  bounds: Bounds;
  /** The id of the chip a sliding finger is over, or null. */
  over?: string | null;
  onPick: (id: string) => void;
  onCancel: () => void;
};

type FanProps = Omit<TargetChooserProps, "over"> & { over: string | null };

/** The fan in its box; it owns the keyboard hook, so it mounts only for two targets or more. */
function Fan({ targets, anchor, bounds, over, onPick, onCancel }: FanProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useStableCallback(() => onCancel());
  useMenuKeyboard({
    open: true,
    panelRef: rootRef,
    close,
    orientation: "horizontal",
  });

  const leave = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    close();
  };
  const shown = targets.slice(0, CHOOSER_MAX_CHIPS);
  const layout = layoutChips(shown.length, anchor, bounds);
  const caption = shown.find((target) => target.id === over)?.label ?? null;
  return (
    <div
      ref={rootRef}
      role="menu"
      aria-label="Targets here"
      tabIndex={-1}
      className="edit-target-chooser"
      data-placement={layout.placement}
      onBlur={leave}
    >
      {shown.map((target, index) => {
        const center = layout.centers[index];
        const style: CSSProperties & Record<"--edit-chooser-ring", string> = {
          left: center.x,
          top: center.y,
          "--edit-chooser-ring": presenceColorVar(target.trackColorIndex),
        };
        return (
          <button
            key={target.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-label={`${KIND_NAMES[target.kind]}, ${target.label}`}
            className={
              target.id === over
                ? "edit-target-chooser-chip is-over"
                : "edit-target-chooser-chip"
            }
            {...{ [TARGET_ID_ATTR]: target.id }}
            style={style}
            onClick={() => onPick(target.id)}
          >
            <SystemIcon name={KIND_ICONS[target.kind]} size={20} />
          </button>
        );
      })}
      {caption === null ? null : (
        <p
          className="edit-target-chooser-caption"
          aria-hidden="true"
          style={{ left: layout.caption.x, top: layout.caption.y }}
        >
          {caption}
        </p>
      )}
    </div>
  );
}

/**
 * The touch target chooser (spec-edit POP-CHOOSER): a fan of 44 px round
 * chips, one per object under a long-press, each with its kind's icon in a
 * ring of its track's colour. A leaf view on plain data: it reads no store and
 * runs no command, and it owns no gesture. The host holds the press, reports
 * the chip under the finger as `over` (by `data-target-id`), calls `onPick(id)`
 * on a lift over a chip and `onCancel()` on a lift anywhere else.
 *
 * It is positioned inside the box it is mounted in (`position: absolute`, no
 * portal, no top layer). The keyboard belongs to `useMenuKeyboard`, which also
 * holds the keymap while the fan is open; a Tab out of the fan cancels it, so
 * the keymap is never held shut behind a fan that has lost its focus. The leaf
 * owns no live region: the host announces "3 targets here".
 */
function TargetChooserView({ over = null, ...props }: TargetChooserProps) {
  if (props.targets.length < 2) return null;
  return <Fan {...props} over={over} />;
}

export const TargetChooser = memo(TargetChooserView);
