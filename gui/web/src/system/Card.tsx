import { type ReactNode, useId } from "react";
import { CloseButton } from "../ui";

export type CardProps = {
  tone?: "default" | "hint";
  title: string;
  /** Names the close button for assistive technology: "Dismiss the setup card". */
  dismissLabel: string;
  /** Without it the card cannot be dismissed and shows no close button. */
  onDismiss?: () => void;
  children: ReactNode;
};

/** A dismissible container for one short message and its actions. */
export function Card({
  tone = "default",
  title,
  dismissLabel,
  onDismiss,
  children,
}: CardProps) {
  const titleId = useId();
  return (
    <section className={`sys-card sys-card--${tone}`} aria-labelledby={titleId}>
      <div className="sys-card-head">
        <h2 id={titleId} className="sys-card-title">
          {title}
        </h2>
        {onDismiss ? (
          <CloseButton
            className="sys-card-close"
            aria-label={dismissLabel}
            title={dismissLabel}
            onClick={onDismiss}
          />
        ) : null}
      </div>
      <div className="sys-card-body">{children}</div>
    </section>
  );
}
