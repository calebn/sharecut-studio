import { SystemIcon } from "../../system/SystemIcon";
import { SegmentedControl, ToggleButton } from "../../ui";
import { kindOf, TRACK_KINDS, type TrackKind } from "./trackKind";

export function TrackKindControl({
  role,
  onPick,
  disabledReason,
}: {
  role: string;
  onPick: (kind: TrackKind) => void;
  disabledReason?: string;
}) {
  const current = kindOf(role);
  return (
    <SegmentedControl label="Kind">
      {TRACK_KINDS.map(({ kind, label, icon }) => (
        <ToggleButton
          key={kind}
          quiet
          pressed={current === kind}
          aria-label={label}
          title={label}
          disabledReason={disabledReason}
          onClick={() => onPick(kind)}
        >
          <SystemIcon name={icon} size={16} />
        </ToggleButton>
      ))}
    </SegmentedControl>
  );
}
