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

/** A group flag's menu as it was when opened: where the flag was, who was in it and where they were. It does not follow the flag. */
type OpenGroup = {
  key: string;
  anchor: DOMRect;
  members: readonly string[];
  label: string;
  rows: readonly GroupRow[];
};

/** The click that ends a press arrives within this long of its pointer down. */
const PRESS_MS = 1000;

const px = (value: number) => `${value}px`;
const flagSelector = (key: string) => `[data-flag="${CSS.escape(key)}"]`;

/**
 * The `+N` flag's menu. The system Presence overlay is aria-hidden and takes no
 * pointer, so the menu is rendered by the host beside it, not inside it. Its
 * open state is kept here against the members' ids: the flag can change key or
 * vanish as people move, and the menu stays as it was until fewer than two of
 * them are still on the ruler.
 */
export function usePresenceGroup({
  flags,
  jumpable,
  names,
  host,
  onGoTo,
}: {
  flags: readonly PresenceFlag[];
  jumpable: ReadonlySet<string>;
  names: ReadonlyMap<string, string>;
  /** Holds the flags: where focus comes back to. */
  host: RefObject<HTMLElement | null>;
  onGoTo: (id: string) => void;
}): {
  onGroup: (key: string, anchor: DOMRect) => void;
  menu: ReactNode;
} {
  const [group, setGroup] = useState<OpenGroup | null>(null);
  const closed = useRef({ key: "", at: Number.NEGATIVE_INFINITY });
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
  const close = useStableCallback(() => {
    const press = window.event;
    if (
      group !== null &&
      press?.type === "pointerdown" &&
      press.target instanceof Element &&
      press.target.closest(flagSelector(group.key))
    ) {
      closed.current = { key: group.key, at: performance.now() };
    }
    setGroup(null);
  });
  const onGroup = useStableCallback((key: string, anchor: DOMRect) => {
    const flag = flags.find((item) => item.key === key);
    const first = flag?.people[0];
    if (flag === undefined || first === undefined) return;
    const press = closed.current;
    closed.current = { key: "", at: Number.NEGATIVE_INFINITY };
    if (press.key === key && performance.now() - press.at < PRESS_MS) return;
    setGroup({
      key,
      anchor,
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
  });
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (group !== null && !shown) setGroup(null);
    const key = shown ? group.key : null;
    const before = opened.current;
    opened.current = key;
    if (before === null || key !== null) return;
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
            aria-label={group.label}
            className="timeline-presence-anchor"
            style={
              {
                "--anchor-top": px(group.anchor.top),
                "--anchor-left": px(group.anchor.left),
                "--anchor-width": px(group.anchor.width),
                "--anchor-height": px(group.anchor.height),
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
              onSelect={() => {
                onGoTo(row.id);
                close();
              }}
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
