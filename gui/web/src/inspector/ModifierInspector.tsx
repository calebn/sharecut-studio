import type { ReactNode } from "react";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { Button } from "../ui/Button";
import { InlineError } from "../ui/InlineError";

export type ModifierAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "danger" | "default";
};

type Props = {
  badge: string;
  title: string;
  subtitle?: string;
  primaryActions?: ModifierAction[];
  children: ReactNode;
  footer?: ReactNode;
  error?: string | null;
};

export function ModifierInspector({
  badge,
  title,
  subtitle,
  primaryActions,
  children,
  footer,
  error,
  embedded = false,
}: Props & { embedded?: boolean }) {
  const Tag = embedded ? "div" : "aside";
  return (
    <Tag
      className={`inspector modifier-inspector${embedded ? " modifier-inspector--embedded" : ""}`}
      {...(embedded ? {} : presenceAnchorProps(presenceAnchor("inspector")))}
    >
      <header className="modifier-header">
        <span className="modifier-badge">{badge}</span>
        <div className="modifier-titles">
          <h2>{title}</h2>
          {subtitle ? <p className="modifier-subtitle">{subtitle}</p> : null}
        </div>
      </header>
      {primaryActions && primaryActions.length > 0 && (
        <div className="modifier-primary-actions">
          {primaryActions.map((action) => (
            <Button
              key={action.label}
              variant={action.variant ?? "default"}
              disabled={action.disabled}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
      <div className="modifier-body">{children}</div>
      {error ? (
        <div className="modifier-error" role="alert">
          <InlineError message={error} />
        </div>
      ) : null}
      {footer ? <footer className="modifier-footer">{footer}</footer> : null}
    </Tag>
  );
}
