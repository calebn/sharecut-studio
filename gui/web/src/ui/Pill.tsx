import type { ReactNode } from "react";

export type PillTone = "neutral" | "ok" | "warning" | "audition";

type Props = {
  tone?: PillTone;
  title?: string;
  className?: string;
  children: ReactNode;
};

/** Read-only status chip (render health, errors, session region). */
export function Pill({ tone = "neutral", title, className, children }: Props) {
  const classes = ["pill", tone === "neutral" ? "" : tone, className]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} title={title}>
      {children}
    </span>
  );
}
