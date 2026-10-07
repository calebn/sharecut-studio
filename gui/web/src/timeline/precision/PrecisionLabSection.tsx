/**
 * View › Labs › Precision drag (#1184): switch between the three prototype
 * ways to move an armed target precisely, in place, so they can be compared
 * on a phone one after another. The menu stays open, as for Theme.
 */
import { MenuSection, SegmentedControl, ToggleButton } from "../../ui";
import {
  PRECISION_VARIANTS,
  type PrecisionVariant,
  setPrecisionVariant,
  usePrecisionVariant,
} from "./precisionLab";

const OPTIONS: { id: PrecisionVariant | null; label: string }[] = [
  { id: null, label: "Off" },
  ...(Object.keys(PRECISION_VARIANTS) as PrecisionVariant[]).map((id) => ({
    id,
    label: PRECISION_VARIANTS[id].label,
  })),
];

export function PrecisionLabSection() {
  const variant = usePrecisionVariant();
  return (
    <MenuSection label="Precision drag">
      <SegmentedControl role="none" className="precision-lab-modes">
        {OPTIONS.map((option) => (
          <ToggleButton
            key={option.id ?? "off"}
            quiet
            role="menuitemradio"
            tabIndex={-1}
            pressed={variant === option.id}
            aria-checked={variant === option.id}
            onClick={() => setPrecisionVariant(option.id)}
          >
            {option.label}
          </ToggleButton>
        ))}
      </SegmentedControl>
    </MenuSection>
  );
}
