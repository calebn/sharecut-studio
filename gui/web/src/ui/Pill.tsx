import type { ReactNode } from "react";

export type PillTone = "neutral" | "ok" | "warning" | "audition";

type Props = {
  tone?: PillTone;
  title?: string;
  className?: string;
  children: ReactNode;
};

/**
 * Class list for a pill of `tone`. Action pills (a `CommandButton` or
 * `Button` that reads as a pill, e.g. the stale-render chip) use this so the
 * tone mapping lives in one place.
 */
export function pillClassName(
  tone: PillTone = "neutral",
  ...extra: (string | false | null | undefined)[]
): string {
  return ["pill", tone === "neutral" ? "" : tone, ...extra]
    .filter(Boolean)
    .join(" ");
}

/** Read-only status chip (render health, errors, session region). */
export function Pill({ tone = "neutral", title, className, children }: Props) {
  const classes = pillClassName(tone, className);
  return (
    <span className={classes} title={title}>
      {children}
    </span>
  );
}
