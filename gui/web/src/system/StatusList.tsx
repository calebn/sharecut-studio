import { Children, isValidElement, type ReactNode } from "react";

type StatusListProps = {
  /** Names the list for assistive tech: "Getting ready". */
  label: string;
  /** StatusRow elements. Each sits in its own list item. */
  children: ReactNode;
};

/**
 * A list of Status rows. The rows are divs, so each gets the `li`; the state
 * is named inside each row by its glyph, and a row's own button is its one
 * tab stop, so the list adds no key handling.
 */
export function StatusList({ label, children }: StatusListProps) {
  return (
    <ul className="sys-status-list" aria-label={label}>
      {Children.toArray(children).map((child) => (
        <li
          key={isValidElement(child) ? (child.key ?? undefined) : undefined}
          className="sys-status-item"
        >
          {child}
        </li>
      ))}
    </ul>
  );
}
