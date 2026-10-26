import { SegmentedControl, ToggleButton } from "../ui";
import { type LinkRole, ROLES } from "./linkRoles";
import { SystemIcon } from "./SystemIcon";

type RoleChipProps = {
  access: LinkRole;
  /** Icon only, named for assistive technology: the phone form. */
  compact?: boolean;
};

/** What a link lets someone do: listen, comment or edit. */
export function RoleChip({ access, compact = false }: RoleChipProps) {
  const entry = ROLES.find((r) => r.id === access) ?? ROLES[0];
  return (
    <span
      className="sys-role"
      data-role={entry.id}
      role="img"
      aria-label={`${entry.label}: ${DESCRIPTION[entry.id]}`}
      title={entry.label}
    >
      <SystemIcon name={entry.icon} size={14} />
      {compact ? null : <span aria-hidden="true">{entry.label}</span>}
    </span>
  );
}

const DESCRIPTION: Record<LinkRole, string> = {
  viewer: "can listen",
  commenter: "can comment",
  editor: "can edit",
};

type RolePickerProps = {
  access: LinkRole;
  onChange: (access: LinkRole) => void;
  compact?: boolean;
};

/** The role as a segmented control, for a link whose role can change. */
export function RolePicker({ access, onChange, compact }: RolePickerProps) {
  return (
    <SegmentedControl label="Role">
      {ROLES.map((entry) => (
        <ToggleButton
          key={entry.id}
          quiet
          pressed={access === entry.id}
          aria-label={`${entry.label}: ${DESCRIPTION[entry.id]}`}
          title={entry.label}
          onClick={() => onChange(entry.id)}
        >
          <SystemIcon name={entry.icon} size={14} />
          {compact ? null : <span>{entry.label}</span>}
        </ToggleButton>
      ))}
    </SegmentedControl>
  );
}
