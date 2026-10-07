/**
 * View › Labs › Precision drag (#1184): Auto on or off, the style Auto
 * switches into, and the last Auto decisions for reporting misses. The menu
 * stays open on Auto and Style, as for Theme, so they can be compared in
 * place on a phone.
 */
import { LegendCheckbox } from "../../layout/OverlayLegendView";
import {
  MenuItem,
  MenuSection,
  SegmentedControl,
  ToggleButton,
} from "../../ui";
import { DECISION_LOG_SIZE, setDecisionLogOpen } from "./decisionLog";
import {
  PRECISION_STYLES,
  type PrecisionStyle,
  setPrecisionAuto,
  setPrecisionStyle,
  usePrecisionLab,
} from "./precisionLab";

const STYLES = Object.keys(PRECISION_STYLES) as PrecisionStyle[];

export function PrecisionLabSection() {
  const { auto, style } = usePrecisionLab();
  return (
    <MenuSection label="Precision drag">
      <div className="overlay-legend" role="none">
        <LegendCheckbox menu checked={auto} onChange={setPrecisionAuto}>
          Auto precision
        </LegendCheckbox>
      </div>
      <SegmentedControl role="none" className="precision-lab-styles">
        {STYLES.map((id) => (
          <ToggleButton
            key={id}
            quiet
            role="menuitemradio"
            tabIndex={-1}
            pressed={style === id}
            aria-checked={style === id}
            onClick={() => setPrecisionStyle(id)}
          >
            {PRECISION_STYLES[id].label}
          </ToggleButton>
        ))}
      </SegmentedControl>
      <MenuItem onSelect={() => setDecisionLogOpen(true)}>
        Auto decisions (last {DECISION_LOG_SIZE})…
      </MenuItem>
    </MenuSection>
  );
}
