import { type ReactNode, type Ref, useId } from "react";
import { BrandSymbol, Button } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";
import type { SystemIconName } from "./icons";
import { SystemIcon } from "./SystemIcon";

type CoverAction = {
  label: string;
  onClick: () => void;
  /**
   * Working on it: the button holds its place, aria-busy and aria-disabled
   * (not natively disabled, so a focused button keeps focus), and ignores presses.
   */
  busy?: boolean;
  /** What the button says while busy. The idle label keeps the width. */
  busyLabel?: string;
};

function ActionLabel({ label, busy, busyLabel }: CoverAction) {
  if (!busy || !busyLabel) {
    return label;
  }
  return (
    <span className="sys-cover-action-label">
      <span aria-hidden="true">{label}</span>
      <span>{busyLabel}</span>
    </span>
  );
}

function pressProps({ busy, onClick }: CoverAction) {
  return {
    onClick: busy ? undefined : onClick,
    "aria-busy": busy || undefined,
    "aria-disabled": busy || undefined,
    title: busy ? BUSY_REASON : undefined,
  };
}

export type CoverProps = {
  /** `page`: whole screen with the wordmark symbol. `region`: inside a surface. */
  size: "page" | "region";
  /** The 48 px case glyph. */
  glyph: SystemIconName;
  title: string;
  /** One sentence. Never server JSON. */
  children: ReactNode;
  primary?: CoverAction;
  secondary?: CoverAction;
  /** Room full: occupant avatars. */
  extra?: ReactNode;
  /** The title's element. "h1" only where the cover is the page's only heading. Default "h2". */
  headingLevel?: "h1" | "h2";
  /** The title element, so a page can move focus to it when the Cover changes. */
  titleRef?: Ref<HTMLHeadingElement>;
};

/** The one "nothing to show here" layout. A `<section>`: the page owns `<main>`. */
export function Cover({
  size,
  glyph,
  title,
  children,
  primary,
  secondary,
  extra,
  headingLevel: Heading = "h2",
  titleRef,
}: CoverProps) {
  const titleId = useId();
  return (
    <section
      className={`sys-cover sys-cover--${size}`}
      aria-labelledby={titleId}
    >
      <div className="sys-cover-inner">
        {size === "page" ? <BrandSymbol className="sys-cover-mark" /> : null}
        <div className="sys-cover-body">
          <span className="sys-cover-glyph">
            <SystemIcon name={glyph} size={48} />
          </span>
          <Heading
            id={titleId}
            ref={titleRef}
            tabIndex={-1}
            className="sys-cover-title"
          >
            {title}
          </Heading>
          <p className="sys-cover-text">{children}</p>
          {extra}
        </div>
        {primary || secondary ? (
          <div className="sys-cover-actions">
            {primary ? (
              <Button variant="primary" {...pressProps(primary)}>
                {primary.busy ? (
                  <SystemIcon name="progress-ring" size={16} progress={0.3} />
                ) : null}
                <ActionLabel {...primary} />
              </Button>
            ) : null}
            {secondary ? (
              <Button variant="link" {...pressProps(secondary)}>
                <ActionLabel {...secondary} />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
