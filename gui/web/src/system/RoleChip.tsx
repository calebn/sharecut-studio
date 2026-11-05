import { type LinkRole, ROLES } from "./linkRoles";
import { SystemIcon } from "./SystemIcon";

type RoleChipProps = {
  access: LinkRole;
  /** Icon only, named for assistive technology: the phone form. */
  compact?: boolean;
  /** Makes the chip a segmented control, for a link that is not made yet. */
  onChange?: (role: LinkRole) => void;
  disabledReason?: string;
};

export function RoleChip({
  access,
  compact = false,
  onChange,
  disabledReason,
}: RoleChipProps) {
  const entry = ROLES.find((r) => r.id === access) ?? ROLES[0];
  if (onChange) {
    return (
      <div className="sys-role-set" role="group" aria-label="Who can open it">
        {ROLES.map((role) => (
          <button
            key={role.id}
            type="button"
            className="sys-role"
            data-role={role.id}
            aria-pressed={role.id === entry.id}
            aria-label={`${role.label}: ${DESCRIPTION[role.id]}`}
            title={disabledReason ?? role.label}
            disabled={disabledReason !== undefined}
            onClick={() => onChange(role.id)}
          >
            <SystemIcon name={role.icon} size={14} />
            {compact ? null : <span aria-hidden="true">{role.label}</span>}
          </button>
        ))}
      </div>
    );
  }
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
