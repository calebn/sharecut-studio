import type { CSSProperties } from "react";
import { initials, presenceColorVar } from "../presence/colors";
import { Icon } from "./Icon";

type Props = {
  name: string;
  colorIndex?: number;
  sessionRole?: string;
  size?: "sm" | "md";
  ring?: "none" | "dashed" | "solid";
  badge?: number;
  title?: string;
};

export function Avatar({
  name,
  colorIndex,
  sessionRole,
  size = "md",
  ring = "none",
  badge,
  title,
}: Props) {
  const classes = [
    "ui-avatar",
    size === "sm" ? "ui-avatar--sm" : "",
    ring === "dashed" ? "ui-avatar--ring-dashed" : "",
    ring === "solid" ? "ui-avatar--ring-solid" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      className={classes}
      style={
        { "--avatar-color": presenceColorVar(colorIndex) } as CSSProperties
      }
      title={title ?? name}
    >
      {sessionRole === "agent" ? (
        <Icon
          name="agent"
          title={title ?? name}
          size={size === "sm" ? 12 : 14}
        />
      ) : (
        initials(name)
      )}
      {badge != null && badge > 0 ? (
        <span className="ui-avatar-badge" aria-hidden>
          {badge > 9 ? "9+" : badge}
        </span>
      ) : null}
    </span>
  );
}
