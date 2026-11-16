import { type ReactNode, type Ref, useId } from "react";
import { BrandSymbol, Button } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";
import { BusyLabel } from "./BusyLabel";
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
  /** What the button says while busy. The wider of it and the idle label sets the width. */
  busyLabel?: string;
};

const Spinner = () => (
  <SystemIcon name="progress-ring" size={16} progress={0.3} />
);

/**
 * With a busy label, the idle and the busy content share one grid cell and the
 * one not shown is hidden, so the button is as wide as the wider of the two
 * and does not move at a press. Without one, a busy primary shows its spinner
 * before the label.
 */
function ActionLabel({
  label,
  busy,
  busyLabel,
  spinner,
}: CoverAction & { spinner?: boolean }) {
  if (!busyLabel) {
    return (
      <>
        {busy && spinner ? <Spinner /> : null}
        {label}
      </>
    );
  }
  return (
    <BusyLabel
      idle={label}
      working={Boolean(busy)}
      busy={
        <>
          {spinner ? <Spinner /> : null}
          {busyLabel}
        </>
      }
    />
  );
}

function pressProps({ busy, busyLabel, onClick }: CoverAction) {
  return {
    // Only a button that shows its busy label looks like it is working; one
    // that is busy without a label keeps the shared disabled look.
    "data-working": busy && busyLabel ? "true" : undefined,
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
  /**
   * What the primary action's last press came to, as a polite status line
   * beside the button, out of flow so nothing moves when it fills. Present
   * (and empty) whenever it is passed, so its first text is announced.
   */
  status?: string;
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
  status,
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
          <div
            className={`sys-cover-actions${status !== undefined ? " sys-cover-actions--status" : ""}`}
          >
            {primary ? (
              <Button variant="primary" {...pressProps(primary)}>
                <ActionLabel {...primary} spinner />
              </Button>
            ) : null}
            {secondary ? (
              <Button variant="link" {...pressProps(secondary)}>
                <ActionLabel {...secondary} />
              </Button>
            ) : null}
            {status !== undefined ? (
              <p className="sys-cover-action-status" role="status">
                {status}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
