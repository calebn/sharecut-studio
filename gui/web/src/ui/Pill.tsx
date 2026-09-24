import type { ReactNode } from "react";

import { type PillTone, pillClassName } from "./pillClassName";

export type { PillTone };

type Props = {
  tone?: PillTone;
  title?: string;
  className?: string;
  children: ReactNode;
};

/** Read-only status chip (render health, errors, session region). */
export function Pill({ tone = "neutral", title, className, children }: Props) {
  const classes = pillClassName(tone, className);
  return (
    <span className={classes} title={title}>
      {children}
    </span>
  );
}
