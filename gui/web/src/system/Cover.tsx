import { type ReactNode, useId } from "react";
import { BrandSymbol, Button } from "../ui";
import type { SystemIconName } from "./icons";
import { SystemIcon } from "./SystemIcon";

export type CoverAction = { label: string; onClick: () => void };

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
          <h2 id={titleId} className="sys-cover-title">
            {title}
          </h2>
          <p className="sys-cover-text">{children}</p>
          {extra}
        </div>
        {primary || secondary ? (
          <div className="sys-cover-actions">
            {primary ? (
              <Button variant="primary" onClick={primary.onClick}>
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
