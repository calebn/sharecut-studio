import { type ReactNode, useState } from "react";
import { Menu, MenuItem } from "../ui";
import type { StageBarProps } from "./StageBar";
import { SystemIcon } from "./SystemIcon";
import { stageBadge } from "./stageBadge";
import { STAGES } from "./verbs";

type StageMenuProps = Partial<
  Pick<StageBarProps, "active" | "onSelect" | "stages" | "badges" | "record">
> & {
  /**
   * Rows after the stages: what the header's right side holds (Follow, search,
   * Invite), for a header too narrow or too short to show it. Without stages
   * (a Viewer or Commenter link, or a window whose Stage bar stays in the
   * header) the menu is these rows alone, behind a More button.
   */
  extras?: ReactNode;
};

/**
 * The tab bar's stages as a menu, for the compact header of a window too short
 * for the tab bar. It takes the tab bar's own props, so the stages, their order,
 * the role gate and the badges are the tab bar's.
 */
export function StageMenu({
  active,
  onSelect,
  stages,
  badges,
  record,
  extras,
}: StageMenuProps) {
  const [open, setOpen] = useState(false);
  const shown = onSelect
    ? STAGES.filter((stage) => (stages ? stages.includes(stage.id) : true))
    : [];
  const current = shown.find((stage) => stage.id === active) ?? shown[0];
  if (!current && !extras) return null;
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label={current ? "Stages" : "More"}
      className="ui-menu-root sys-menu sys-header-stage-menu"
      trigger={(props) =>
        current ? (
          <button
            type="button"
            className="sys-icon-btn sys-header-stage-button"
            aria-label={`Stage menu, ${current.label}`}
            title="Stages"
            {...props}
          >
            <SystemIcon name={current.icon} size={16} />
            <span className="sys-header-stage-label">{current.label}</span>
            <SystemIcon name="chevron-down" size={16} />
          </button>
        ) : (
          <button
            type="button"
            className="sys-icon-btn sys-header-more-button"
            aria-label="More"
            title="More"
            {...props}
          >
            <SystemIcon name="ellipsis" size={16} />
          </button>
        )
      }
    >
      {shown.map((stage) => {
        const badge = stageBadge(stage.id, badges, record);
        return (
          <MenuItem
            key={stage.id}
            onSelect={() => {
              setOpen(false);
              onSelect?.(stage.id);
            }}
          >
            <SystemIcon name={stage.icon} size={16} />
            {stage.label}
            {stage.id === active ? (
              <span className="sr-only"> (current)</span>
            ) : null}
            {badge ? " " : null}
            {badge}
          </MenuItem>
        );
      })}
      {extras}
    </Menu>
  );
}
