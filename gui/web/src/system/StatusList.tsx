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
 * itself, instead of falling to the page. When the row itself goes, it moves to
 * the nearest row left, or to the list.
 */
export function StatusList({ label, children }: StatusListProps) {
  const list = useRef<HTMLUListElement>(null);
  useFocusRescue(list, (target) => {
    const items = [...(list.current?.children ?? [])] as HTMLElement[];
    const at = items.findIndex((item) => item.contains(target));
    return () => {
      const near = [...items.slice(at), ...items.slice(0, at).reverse()].find(
        (item) => item.isConnected,
      );
      return (
        near?.querySelector<HTMLElement>(".sys-status-toggle") ??
        near ??
        list.current
      );
    };
  });
  return (
    <ul ref={list} tabIndex={-1} className="sys-status-list" aria-label={label}>
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
