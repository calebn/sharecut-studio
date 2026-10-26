import { type LinkRole, ROLES } from "./linkRoles";
import { SystemIcon } from "./SystemIcon";

type RoleChipProps = {
  access: LinkRole;
  /** Icon only, named for assistive technology: the phone form. */
  compact?: boolean;
};

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
