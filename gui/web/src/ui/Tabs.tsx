import type {
  ButtonHTMLAttributes,
  KeyboardEvent,
  ReactNode,
  Ref,
} from "react";

type TabListProps = {
  label: string;
  className?: string;
  children: ReactNode;
};

const TAB_SELECTOR = '[role="tab"]:not([aria-disabled="true"])';

/**
 * Container for `Tab`s: `role="tablist"` with Left, Right, Home and End
 * moving focus to a tab and selecting it. Tab order is one stop (the selected
 * tab), so the panel's controls are the next stop.
 */
export function TabList({ label, className, children }: TabListProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(TAB_SELECTOR),
    ];
    const from = tabs.findIndex((tab) => tab === document.activeElement);
    if (from < 0) return;
    const to =
      event.key === "ArrowRight"
        ? (from + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (from - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : -1;
    if (to < 0) return;
    event.preventDefault();
    tabs[to]!.focus();
    tabs[to]!.click();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className={className}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

type TabProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "role" | "aria-selected" | "tabIndex" | "type"
> & {
  selected: boolean;
  panelId: string;
  ref?: Ref<HTMLButtonElement>;
  children: ReactNode;
};

export function Tab({
  selected,
  panelId,
  className,
  children,
  ...rest
}: TabProps) {
  const classes = [
    "ui-control",
    "ui-control--quiet",
    selected ? "active" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      role="tab"
      data-ui-kind="tab"
      aria-selected={selected}
      aria-controls={panelId}
      tabIndex={selected ? 0 : -1}
      className={classes}
      {...rest}
    >
      {children}
    </button>
  );
}
