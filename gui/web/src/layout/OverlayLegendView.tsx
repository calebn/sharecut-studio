import type { ReactNode } from "react";
import type { LayerVisibility } from "../state/types";

const TOGGLES: {
  key: keyof LayerVisibility;
  label: string;
  swatch: "pending" | "envelope" | "markers" | "comments" | "silence" | "snap";
}[] = [
  { key: "showEdits", label: "Pending edits", swatch: "pending" },
  { key: "showLevels", label: "Volume envelope", swatch: "envelope" },
  { key: "showMarkers", label: "Markers", swatch: "markers" },
  { key: "showComments", label: "Comments", swatch: "comments" },
  { key: "showSilence", label: "Silence shading", swatch: "silence" },
  { key: "showSnapPoints", label: "Snap points", swatch: "snap" },
];

/** A layer/legend checkbox row, shared by the overlay legend and menu-hosted toggles like Fit tracks to window height. */
export function LegendCheckbox({
  menu,
  checked,
  onChange,
  children,
}: {
  menu?: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="overlay-legend-item">
      <input
        type="checkbox"
        role={menu ? "menuitemcheckbox" : undefined}
        aria-checked={menu ? checked : undefined}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  );
}

/** Props-only overlay legend: timeline layer visibility only (adding a chapter is `edit.addChapter`). */
export function OverlayLegendView({
  menu = false,
  layers,
  onLayerChange,
}: {
  menu?: boolean;
  layers: LayerVisibility;
  onLayerChange: (key: keyof LayerVisibility, visible: boolean) => void;
}) {
  return (
    <div
      className="overlay-legend"
      role={menu ? "none" : "group"}
      aria-label={menu ? undefined : "Timeline layers"}
    >
      {TOGGLES.map(({ key, label, swatch }) => (
        <LegendCheckbox
          key={key}
          menu={menu}
          checked={layers[key]}
          onChange={(checked) => onLayerChange(key, checked)}
        >
          <span
            className={`overlay-legend-swatch overlay-legend-swatch--${swatch}`}
            aria-hidden="true"
          />
          {label}
        </LegendCheckbox>
      ))}
    </div>
  );
}
