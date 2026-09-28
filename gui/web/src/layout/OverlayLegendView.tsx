import type { ReactNode } from "react";
import type { LayerVisibility } from "../state/types";
import { Button } from "../ui";

const TOGGLES: {
  key: keyof LayerVisibility;
  label: string;
  swatch?: "silence" | "snap";
}[] = [
  { key: "showEdits", label: "Edits" },
  { key: "showLevels", label: "Levels" },
  { key: "showMarkers", label: "Markers" },
  { key: "showComments", label: "Comments" },
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

/** Props-only overlay legend, shared by the desktop legend and the view menu. */
export function OverlayLegendView({
  menu = false,
  layers,
  onLayerChange,
  onAddChapter,
  addChapterBusy = false,
}: {
  menu?: boolean;
  layers: LayerVisibility;
  onLayerChange: (key: keyof LayerVisibility, visible: boolean) => void;
  onAddChapter?: () => void;
  /** An add is in flight: + Chapter is aria-disabled (still focusable, so keyboard focus stays put) and ignores clicks until it settles. */
  addChapterBusy?: boolean;
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
          {swatch ? (
            <span
              className={`overlay-legend-swatch overlay-legend-swatch--${swatch}`}
              aria-hidden="true"
            />
          ) : null}
          {label}
        </LegendCheckbox>
      ))}
      {onAddChapter && layers.showMarkers && (
        <Button
          role={menu ? "menuitem" : undefined}
          className="transcript-follow-btn"
          title="Add chapter marker at playhead"
          // aria-disabled, not disabled: the button keeps keyboard focus (and
          // its place in a menu's arrow-key order) while the add is in flight.
          aria-disabled={addChapterBusy || undefined}
          onClick={() => {
            if (!addChapterBusy) {
              onAddChapter?.();
            }
          }}
        >
          + Chapter
        </Button>
      )}
    </div>
  );
}
