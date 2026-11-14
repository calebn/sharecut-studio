import { type ReactNode, useId } from "react";
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
};

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
  headingLevel,
}: CoverProps) {
  const titleId = useId();
  const Heading = headingLevel ?? "h2";
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
          <Heading id={titleId} className="sys-cover-title">
            {title}
          </Heading>
          <p className="sys-cover-text">{children}</p>
          {extra}
        </div>
        {primary || secondary ? (
          <div className="sys-cover-actions">
            {primary ? (
              <Button
                variant="primary"
                onClick={primary.busy ? undefined : primary.onClick}
                aria-busy={primary.busy || undefined}
                aria-disabled={primary.busy || undefined}
                title={primary.busy ? BUSY_REASON : undefined}
              >
                {primary.busy ? (
                  <SystemIcon name="progress-ring" size={16} progress={0.3} />
                ) : null}
                {primary.label}
              </Button>
            ) : null}
            {secondary ? (
              <Button variant="link" onClick={secondary.onClick}>
                {secondary.label}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
