import type { ReactNode } from "react";
import { addChapter } from "../api";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { LayerVisibility } from "../state/types";
import { useDaw } from "../state/useDaw";
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

export function OverlayLegend({ menu = false }: { menu?: boolean }) {
  const { layers, setLayerVisible, projectPath, setSelection } = useDaw(
    (s) => ({
      layers: s.layers,
      setLayerVisible: s.setLayerVisible,
      projectPath: s.projectPath,
      setSelection: s.setSelection,
    }),
  );
  const hostEditable = !isShareProjectKey(projectPath);

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
          onChange={(checked) => setLayerVisible(key, checked)}
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
      {hostEditable && layers.showMarkers && (
        <Button
          role={menu ? "menuitem" : undefined}
          className="transcript-follow-btn"
          title="Add chapter marker at playhead"
          onClick={() => {
            void (async () => {
              const playheadSec = useDawStore.getState().playheadSec;
              const title = `Chapter ${playheadSec.toFixed(1)}s`;
              await addChapter(projectPath, playheadSec, title);
              setSelection({
                kind: "chapter",
                id: title,
                time: playheadSec,
              });
            })();
          }}
        >
          + Chapter
        </Button>
      )}
    </div>
  );
}
