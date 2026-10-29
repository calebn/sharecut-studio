import {
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject,
  useRef,
  useState,
} from "react";
import { Button, Menu, MenuItem } from "../ui";
import { disabledAttrs } from "../ui/disabledReason";
import { useAnchoredPanel } from "../ui/useAnchoredPanel";
import { type BarItem, foldDock, slotsOf } from "./actionBarSlots";
import { type BarId, barDisplay } from "./editActionSets";
import { SystemIcon } from "./SystemIcon";

export type { BarItem };

export type ActionBarPlacement =
  | {
      readonly form: "floating";
      readonly anchorRef: RefObject<HTMLElement | null>;
      /** A value that moves the anchor without a scroll or resize. */
      readonly moves?: unknown;
    }
  | { readonly form: "dock" }
  | { readonly form: "inline" };

export type ActionBarProps = {
  readonly placement: ActionBarPlacement;
  /** The Scope chip, a count, or a link such as Review's Open in Edit. */
  readonly leading?: ReactNode;
  /** In the order given: the bar never sorts. A `more` item opens `more`. */
  readonly items: readonly BarItem[];
  readonly more?: readonly BarItem[];
  /** Trailing and accent filled. Only a real gate sets `disabledReason`. */
  readonly primary?: BarItem & {
    readonly disabledReason?: string;
    /** Id of the visible note that gives `disabledReason`. */
    readonly describedBy?: string;
  };
  /** Review's A/B, in the middle of the dock. */
  readonly center?: ReactNode;
  /** After the verbs where a guest has no primary. */
  readonly trailing?: ReactNode;
  readonly ariaLabel?: string;
  readonly onVerb: (id: BarId) => void;
};

type Look = "floating" | "dock" | "inline";

const AB_LETTER: Partial<Record<BarId, string>> = {
  hearBefore: "A",
  hearAfter: "B",
};

const labelOf = (item: BarItem) => item.label ?? barDisplay(item.id).label;
const titleOf = (item: BarItem) =>
  `${labelOf(item)}${barDisplay(item.id).hint}`;

type LookButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "title"
> & {
  look: Look;
  item: BarItem;
};

function LookButton({ look, item, ...rest }: LookButtonProps) {
  const display = barDisplay(item.id);
  const label = labelOf(item);
  const letter = AB_LETTER[item.id];
  const glyph = display.icon;
  const common = {
    type: "button",
    title: titleOf(item),
    "aria-pressed": item.pressed,
    ...rest,
  } as const;
  if (look === "inline") {
    return (
      <Button
        variant={item.tone === "link" ? "link" : "default"}
        {...common}
        aria-label={letter ? label : undefined}
      >
        {letter ?? (
          <>
            {glyph ? <SystemIcon name={glyph} size={16} /> : null}
            {label}
          </>
        )}
      </Button>
    );
  }
  if (look === "dock") {
    return (
      <button
        className="sys-actions-dock-btn"
        {...common}
        aria-label={letter ? label : undefined}
      >
        {letter ?? (
          <>
            {glyph ? <SystemIcon name={glyph} size={20} /> : null}
            <span className="sys-actions-dock-label">{label}</span>
          </>
        )}
      </button>
    );
  }
  return (
    <button
      className="sys-icon-btn sys-actions-icon"
      {...common}
      aria-label={label}
    >
      {letter ?? (glyph ? <SystemIcon name={glyph} size={16} /> : null)}
    </button>
  );
}

function PrimaryButton({
  look,
  item,
  onVerb,
}: {
  look: Look;
  item: NonNullable<ActionBarProps["primary"]>;
  onVerb: ActionBarProps["onVerb"];
}) {
  const glyph = barDisplay(item.id).icon;
  const label = labelOf(item);
  const size = look === "dock" ? 20 : 16;
  const icon = glyph ? <SystemIcon name={glyph} size={size} /> : null;
  return (
    <Button
      variant="primary"
      className={
        look === "inline"
          ? undefined
          : `sys-actions-primary sys-actions-primary--${look}`
      }
      title={titleOf(item)}
      aria-label={look === "floating" ? label : undefined}
      onClick={() => onVerb(item.id)}
      aria-describedby={item.describedBy}
      {...disabledAttrs(item.disabledReason)}
    >
      {icon}
      {look === "floating" ? null : look === "dock" ? (
        <span className="sys-actions-dock-label">{label}</span>
      ) : (
        label
      )}
    </Button>
  );
}

function MoreMenu({
  look,
  rows,
  onVerb,
}: {
  look: Look;
  rows: readonly BarItem[];
  onVerb: ActionBarProps["onVerb"];
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label="More actions"
      className="ui-menu-root sys-menu"
      trigger={(trigger) => (
        <LookButton look={look} item={{ id: "more" }} {...trigger} />
      )}
    >
      {rows.map((row) => {
        const glyph = barDisplay(row.id).icon;
        return (
          <MenuItem
            key={row.id}
            onSelect={() => {
              setOpen(false);
              onVerb(row.id);
            }}
          >
            {glyph ? <SystemIcon name={glyph} size={16} /> : null}
            {labelOf(row)}
          </MenuItem>
        );
      })}
    </Menu>
  );
}

function Items({
  look,
  items,
  more,
  onVerb,
}: {
  look: Look;
  items: readonly BarItem[];
  more: readonly BarItem[];
  onVerb: ActionBarProps["onVerb"];
}) {
  return slotsOf(items).map((slot) => {
    const [first, second] = slot as [BarItem, BarItem | undefined];
    if (second)
      return (
        <span
          key={first.id}
          role="group"
          aria-label="Hear before and after"
          className="sys-actions-ab"
        >
          {slot.map((item) => (
            <LookButton
              key={item.id}
              look={look}
              item={item}
              onClick={() => onVerb(item.id)}
            />
          ))}
        </span>
      );
    return first.id === "more" ? (
      <MoreMenu key={first.id} look={look} rows={more} onVerb={onVerb} />
    ) : (
      <LookButton
        key={first.id}
        look={look}
        item={first}
        onClick={() => onVerb(first.id)}
      />
    );
  });
}

type FormProps = Omit<ActionBarProps, "placement" | "ariaLabel"> & {
  ariaLabel: string;
};

function Inline({
  leading,
  items,
  more = [],
  primary,
  center,
  trailing,
  ariaLabel,
  onVerb,
}: FormProps) {
  return (
    <div
      className="sys-actions sys-actions--inline"
      role="group"
      aria-label={ariaLabel}
    >
      {leading}
      {center}
      {items.length > 0 || primary ? (
        <span className="sys-actions-decide">
          <Items look="inline" items={items} more={more} onVerb={onVerb} />
          {primary ? (
            <PrimaryButton look="inline" item={primary} onVerb={onVerb} />
          ) : null}
        </span>
      ) : null}
      {trailing ? (
        <span className="sys-actions-trailing">{trailing}</span>
      ) : null}
    </div>
  );
}

function Dock({
  leading,
  items,
  more = [],
  primary,
  center,
  trailing,
  ariaLabel,
  onVerb,
}: FormProps) {
  const grip = items.some((item) => item.id === "inspect");
  const folded = foldDock(items, more, primary !== undefined);
  const classes = ["sys-actions", "sys-actions--dock"];
  if (center) classes.push("sys-actions--dock-center");
  if (grip) classes.push("sys-actions--dock-grip");
  return (
    <div className={classes.join(" ")} role="group" aria-label={ariaLabel}>
      {grip ? (
        <button
          type="button"
          className="sys-actions-grip"
          aria-label="Inspect"
          title={titleOf({ id: "inspect" })}
          onClick={() => onVerb("inspect")}
        />
      ) : null}
      <div className="sys-dock-slot sys-dock-slot--start">
        {leading}
        <Items look="dock" items={folded.items} more={[]} onVerb={onVerb} />
        {folded.more.length > 0 ? (
          <MoreMenu look="dock" rows={folded.more} onVerb={onVerb} />
        ) : null}
      </div>
      {center ? <div className="sys-dock-slot">{center}</div> : null}
      <div className="sys-dock-slot sys-dock-slot--end">
        {trailing}
        {primary ? (
          <PrimaryButton look="dock" item={primary} onVerb={onVerb} />
        ) : null}
      </div>
    </div>
  );
}

function Floating({
  placement,
  leading,
  items,
  more = [],
  primary,
  ariaLabel,
  onVerb,
}: FormProps & {
  placement: Extract<ActionBarPlacement, { form: "floating" }>;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  useAnchoredPanel(
    barRef,
    {
      reason: "The Action bar floats beside its selection",
      ref: placement.anchorRef,
      moves: placement.moves,
      prefer: "above",
    },
    true,
  );
  return (
    <div
      ref={barRef}
      className="sys-actions sys-actions--floating"
      role="group"
      aria-label={ariaLabel}
    >
      {leading}
      <Items look="floating" items={items} more={more} onVerb={onVerb} />
      {primary ? (
        <PrimaryButton look="floating" item={primary} onVerb={onVerb} />
      ) : null}
    </div>
  );
}

export function SelectionCount({ count }: { count: number }) {
  return (
    <span className="sys-actions-count">
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{count} selected</span>
    </span>
  );
}

/**
 * The one Action bar (design-system element 7) in its three forms. It draws
 * the items it is given in the order given and branches on nothing but the
 * form; which verbs a selection gets is `resolveBar`'s answer.
 */
export function ActionBar({
  placement,
  ariaLabel = "Actions",
  ...rest
}: ActionBarProps) {
  const props = { ...rest, ariaLabel };
  if (placement.form === "floating")
    return <Floating {...props} placement={placement} />;
  return placement.form === "dock" ? (
    <Dock {...props} />
  ) : (
    <Inline {...props} />
  );
}
