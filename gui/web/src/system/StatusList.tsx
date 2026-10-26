import { Children, isValidElement, type ReactNode, useRef } from "react";
import { useFocusRescue } from "./useFocusRescue";

type StatusListProps = {
  /** Names the list for assistive tech: "Getting ready". */
  label: string;
  /** StatusRow elements. Each sits in its own list item. */
  children: ReactNode;
};

/**
 * A list of Status rows. The rows are divs, so each gets the `li`; the state
 * is named inside each row by its glyph, and a row's own button is its one
 * tab stop, so the list adds no key handling. When the button a row acted on
 * goes away with the new state, focus moves to the row's toggle, or to the row
 * itself, instead of falling to the page.
 */
export function StatusList({ label, children }: StatusListProps) {
  const list = useRef<HTMLUListElement>(null);
  useFocusRescue(list, (target) => {
    const item = target.closest("li");
    return () => item?.querySelector<HTMLElement>(".sys-status-toggle") ?? item;
  });
  return (
    <ul ref={list} className="sys-status-list" aria-label={label}>
      {Children.toArray(children)
        .filter(isValidElement)
        .map((child) => (
          <li key={child.key} tabIndex={-1} className="sys-status-item">
            {child}
          </li>
        ))}
    </ul>
  );
}
