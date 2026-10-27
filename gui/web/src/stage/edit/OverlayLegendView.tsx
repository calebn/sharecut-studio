import type { ReactNode } from "react";
import type { LayerVisibility } from "../../state/types";

const TOGGLES: {
  key: keyof LayerVisibility;
  label: string;
  swatch:
    | "pending"
    | "envelope"
    | "markers"
    | "comments"
    | "silence"
    | "snap"
    | "prosody";
  hostOnly?: boolean;
}[] = [
  { key: "showEdits", label: "Pending edits", swatch: "pending" },
  { key: "showLevels", label: "Volume envelope", swatch: "envelope" },
  { key: "showMarkers", label: "Markers", swatch: "markers" },
  { key: "showComments", label: "Comments", swatch: "comments" },
  { key: "showSilence", label: "Silence shading", swatch: "silence" },
  { key: "showSnapPoints", label: "Snap points", swatch: "snap" },
  { key: "showProsody", label: "Prosody", swatch: "prosody", hostOnly: true },
];

/** A layer/legend checkbox row, shared by the overlay legend and the View sheet's own toggles. */
export function LegendCheckbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="overlay-legend-item">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  );
}

/** Props-only overlay legend: timeline layer visibility only (adding a chapter is `edit.addChapter`). */
export function OverlayLegendView({
  layers,
  onLayerChange,
  hostLayers = true,
}: {
  layers: LayerVisibility;
  onLayerChange: (key: keyof LayerVisibility, visible: boolean) => void;
  /** false for share viewers: hides host-only layers such as Prosody. */
  hostLayers?: boolean;
}) {
  return (
    <div className="overlay-legend" role="group" aria-label="Timeline layers">
      {TOGGLES.filter((t) => hostLayers || !t.hostOnly).map(
        ({ key, label, swatch }) => (
          <LegendCheckbox
            key={key}
            checked={layers[key]}
            onChange={(checked) => onLayerChange(key, checked)}
          >
            <span
              className={`overlay-legend-swatch overlay-legend-swatch--${swatch}`}
              aria-hidden="true"
            />
            {label}
          </LegendCheckbox>
        ),
      )}
    </div>
  );
}
