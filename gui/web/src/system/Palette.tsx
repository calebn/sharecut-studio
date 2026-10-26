import { type KeyboardEvent, useId, useMemo, useState } from "react";
import { KeyCaps } from "./KeyCaps";
import {
  type PaletteGroup,
  type PaletteItem,
  resultGroups,
} from "./paletteResults";
import { SystemIcon } from "./SystemIcon";

export type { PaletteGroup, PaletteItem };

export type PaletteProps = {
  items: readonly PaletteItem[];
  /** Shown when the query is empty. */
  recent?: readonly string[];
  initialQuery?: string;
  /** `sheet`: the phone's full-height form. */
  form?: "card" | "sheet";
  onRun?: (item: PaletteItem) => void;
  onClose?: () => void;
};

/**
 * Search-first command palette. Rows show the verb icon, name, context and key
 * caps. A host mounts it in a centered Dialog (phone: a full-height Sheet).
 */
export function Palette({
  items,
  recent = [],
  initialQuery = "",
  form = "card",
  onRun,
  onClose,
}: PaletteProps) {
  const listId = useId();
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const groups = useMemo(
    () => resultGroups(items, query, recent),
    [items, query, recent],
  );
  const flat = groups.flatMap((group) => group.items);
  const current = Math.min(active, Math.max(flat.length - 1, 0));
  const optionId = (index: number) => `${listId}-opt-${index}`;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + flat.length) % Math.max(flat.length, 1));
    } else if (event.key === "Enter" && flat[current]) {
      event.preventDefault();
      onRun?.(flat[current]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose?.();
    }
  };
  const offsets = groups.map((_, i) =>
    groups.slice(0, i).reduce((sum, group) => sum + group.items.length, 0),
  );
  return (
    <div
      role="dialog"
      aria-label="Palette"
      className={`sys-palette sys-palette--${form}`}
    >
      <div className="sys-palette-search">
        <SystemIcon name="search" size={16} />
        <input
          type="text"
          role="combobox"
          aria-label="Search commands"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            flat.length > 0 ? optionId(current) : undefined
          }
          placeholder="Search commands, stages, people"
          onKeyDown={onKeyDown}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label="Results"
        className="sys-palette-list"
      >
        {groups.map((group, groupIndex) => (
          <div
            key={group.name}
            role="group"
            aria-labelledby={`${listId}-${group.name}`}
          >
            <div id={`${listId}-${group.name}`} className="sys-palette-group">
              {group.name}
            </div>
            {group.items.map((item, itemIndex) => {
              const position = offsets[groupIndex] + itemIndex;
              return (
                <div
                  key={item.id}
                  id={optionId(position)}
                  role="option"
                  aria-selected={position === current}
                  tabIndex={-1}
                  className="sys-palette-row"
                  // Keep focus in Search, which owns the keyboard.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onRun?.(item)}
                  onMouseMove={() => setActive(position)}
                  // Search owns the keyboard; this covers assistive tech that
                  // moves real focus onto a row.
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onRun?.(item);
                    }
                  }}
                >
                  {item.icon ? (
                    <SystemIcon name={item.icon} size={16} />
                  ) : (
                    <span className="sys-palette-noicon" />
                  )}
                  <span className="sys-palette-name">{item.label}</span>
                  {item.context ? (
                    <span className="sys-palette-context">{item.context}</span>
                  ) : null}
                  <KeyCaps chords={item.keys ?? []} />
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <p className="sys-palette-empty" role="status">
        {flat.length === 0 ? "No matches" : null}
      </p>
    </div>
  );
}
