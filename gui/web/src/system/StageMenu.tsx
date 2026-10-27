import { useState } from "react";
import { Menu, MenuItem } from "../ui";
import { Badge, type StageBarProps } from "./StageBar";
import { SystemIcon } from "./SystemIcon";
import { STAGES } from "./verbs";

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
  live,
}: Pick<StageBarProps, "active" | "onSelect" | "stages" | "badges" | "live">) {
  const [open, setOpen] = useState(false);
  const shown = STAGES.filter((stage) =>
    stages ? stages.includes(stage.id) : true,
  );
  const current = shown.find((stage) => stage.id === active) ?? shown[0];
  if (!current) return null;
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label="Stages"
      className="ui-menu-root sys-menu sys-header-stage-menu"
      trigger={(props) => (
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
      )}
    >
      {shown.map((stage) => {
        const badge =
          stage.id === "record" && live
            ? ({ kind: "live" } as const)
            : badges?.[stage.id];
        return (
          <MenuItem
            key={stage.id}
            onSelect={() => {
              setOpen(false);
              onSelect(stage.id);
            }}
          >
            <SystemIcon name={stage.icon} size={16} />
            {stage.label}
            {stage.id === active ? (
              <span className="sr-only"> (current)</span>
            ) : null}
            {badge ? " " : null}
            {badge ? <Badge badge={badge} /> : null}
          </MenuItem>
        );
      })}
    </Menu>
  );
}
