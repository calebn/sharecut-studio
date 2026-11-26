import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { presenceColorVar } from "../presence/colors";
import type { PresenceFlag } from "../system/presenceMath";
import { Menu, MenuItem } from "../ui/Menu";
import { formatTimeShort } from "../utils/time";
import { useStableCallback } from "../utils/useStableCallback";

type GroupRow = {
  id: string;
  name: string;
  colorIndex: number;
  time: string;
};

/** A group flag's menu as it was when opened: where the pill was, who was in it and where they were. It does not follow the flag. */
type OpenGroup = {
  key: string;
  anchor: DOMRect;
  press: DOMRect;
  members: readonly string[];
  label: string;
  rows: readonly GroupRow[];
};

const px = (value: number) => `${value}px`;
const flagSelector = (key: string) => `[data-flag="${CSS.escape(key)}"]`;

/**
 * The `+N` flag's menu. The system Presence overlay is aria-hidden and takes no
 * pointer, so the menu is rendered by the host beside it, not inside it. Its
 * open state is kept here against the members' ids: the flag can change key or
 * vanish as people move, and the menu stays as it was until the window moves
 * (a scroll or a zoom) or fewer than two of the members are still in one flag.
 * Its trigger is an unseen box over the pill, so a press on the pill is a press
 * on the trigger and toggles the menu shut.
 */
export function usePresenceGroup({
  flags,
  jumpable,
  names,
  host,
  start,
  pxPerSecond,
  onGoTo,
}: {
  flags: readonly PresenceFlag[];
  jumpable: ReadonlySet<string>;
  names: ReadonlyMap<string, string>;
  /** Holds the flags: where focus comes back to. */
  host: RefObject<HTMLElement | null>;
  /** The window's left edge in seconds and its scale: the menu closes when either moves. */
  start: number;
  pxPerSecond: number;
  onGoTo: (id: string) => void;
}): {
  onGroup: (key: string, anchor: DOMRect, press: DOMRect) => void;
  menu: ReactNode;
} {
  const [group, setGroup] = useState<OpenGroup | null>(null);
  const present = useMemo(
    () => new Set(flags.flatMap((flag) => flag.people.map((p) => p.id))),
    [flags],
  );
  const together = (group?.members ?? []).length
    ? Math.max(
        0,
        ...flags.map(
          (flag) =>
            flag.people.filter((p) => group?.members.includes(p.id)).length,
        ),
      )
    : 0;
  const shown = group !== null && together >= 2;
  const returnFocus = useRef(false);
  const close = useStableCallback(() => setGroup(null));
  const choose = useStableCallback((id: string) => {
    returnFocus.current = true;
    onGoTo(id);
    setGroup(null);
  });
  const onGroup = useStableCallback(
    (key: string, anchor: DOMRect, press: DOMRect) => {
      const flag = flags.find((item) => item.key === key);
      const first = flag?.people[0];
      if (flag === undefined || first === undefined) return;
      setGroup({
        key,
        anchor,
        press,
        members: flag.people.map((person) => person.id),
        label: `${flag.people.length} people near ${formatTimeShort(first.time)}`,
        rows: flag.people
          .filter((person) => jumpable.has(person.id))
          .map((person) => ({
            id: person.id,
            name: names.get(person.id) ?? person.name,
            colorIndex: person.colorIndex,
            time: formatTimeShort(person.time),
          })),
      });
    },
  );
  useEffect(() => {
    setGroup(null);
  }, [start, pxPerSecond]);
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (group !== null && !shown) {
      returnFocus.current = true;
      setGroup(null);
    }
    const key = shown ? group.key : null;
    const before = opened.current;
    opened.current = key;
    if (before === null || key !== null) return;
    const restore = returnFocus.current;
    returnFocus.current = false;
    if (!restore) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const target =
      host.current?.querySelector<HTMLElement>(flagSelector(before)) ??
      document.querySelector<HTMLElement>(".timeline-ruler .sys-ruler-body");
    target?.focus();
  }, [group, shown, host]);

  const menu =
    group !== null && shown ? (
      <Menu
        open
        onOpenChange={close}
        label={group.label}
        className="ui-menu-root sys-menu timeline-presence-menu"
        trigger={(trigger) => (
          <button
            type="button"
            {...trigger}
            tabIndex={-1}
            aria-hidden="true"
            className="timeline-presence-anchor"
            style={
              {
                "--anchor-top": px(group.anchor.top),
                "--anchor-left": px(group.anchor.left),
                "--anchor-width": px(group.anchor.width),
                "--anchor-height": px(group.anchor.height),
                "--anchor-press-top": px(group.press.top - group.anchor.top),
                "--anchor-press-left": px(group.press.left - group.anchor.left),
                "--anchor-press-width": px(group.press.width),
                "--anchor-press-height": px(group.press.height),
              } as CSSProperties
            }
          />
        )}
      >
        <div className="avatar-card-head" aria-hidden="true">
          <span className="avatar-card-name">
            {group.members.length} people here
          </span>
          <span className="avatar-card-meta">Go to where they are</span>
        </div>
        {group.rows
          .filter((row) => present.has(row.id))
          .map((row) => (
            <MenuItem
              key={row.id}
              detail={row.time}
              ariaDescription={`at ${row.time}`}
              onSelect={() => choose(row.id)}
            >
              <span
                className="timeline-presence-dot"
                aria-hidden="true"
                style={
                  {
                    "--sys-presence-color": presenceColorVar(row.colorIndex),
                  } as CSSProperties
                }
              />
              {row.name}
            </MenuItem>
          ))}
      </Menu>
    ) : null;
  return { onGroup, menu };
}
