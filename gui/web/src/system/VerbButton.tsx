import type { ButtonHTMLAttributes } from "react";
import type { SystemIconName } from "./icons";
import { SystemIcon } from "./SystemIcon";
import { hintOf, verbOf } from "./verbDisplay";
import type { VerbId } from "./verbs";

type Props = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "aria-label"
> & {
  verb: VerbId;
  /** Show the verb's second icon (Pause for Play). */
  alt?: boolean;
  /** Overrides the verb label as the accessible name. */
  label?: string;
  size?: number;
  /** A visible word under the icon. The accessible name stays the verb's label. */
  caption?: string;
};

/** The word under a dock disc. Decorative: the button's accessible name says it. */
export function DockLabel({ children }: { children: string }) {
  return (
    <span className="sys-dock-label" aria-hidden="true">
      {children}
    </span>
  );
}

/** An icon-only button named from the verb table, with the key in its tooltip. */
export function VerbButton({
  verb,
  alt,
  label,
  size = 16,
  caption,
  className,
  ...rest
}: Props) {
  const def = verbOf(verb);
  const icon: SystemIconName | null = (alt && def.iconAlt) || def.icon;
  const name = label ?? def.label;
  return (
    <button
      type="button"
      className={className ? `sys-icon-btn ${className}` : "sys-icon-btn"}
      aria-label={name}
      title={`${name}${hintOf(def)}`}
      {...rest}
    >
      {icon ? <SystemIcon name={icon} size={size} /> : null}
      {caption ? <DockLabel>{caption}</DockLabel> : null}
    </button>
  );
}
