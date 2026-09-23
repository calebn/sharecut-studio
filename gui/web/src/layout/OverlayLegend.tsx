import { addChapter } from "../api";
import { isShareProjectKey } from "../shareMode";
import type { LayerVisibility } from "../state/types";
import { useDaw } from "../state/useDaw";
import { Button } from "../ui";

const TOGGLES: { key: keyof LayerVisibility; label: string }[] = [
  { key: "showEdits", label: "Edits" },
  { key: "showLevels", label: "Levels" },
  { key: "showMarkers", label: "Markers" },
  { key: "showComments", label: "Comments" },
];

export function OverlayLegend({ menu = false }: { menu?: boolean }) {
  const { layers, setLayerVisible, projectPath, playheadSec, setSelection } =
    useDaw();
  const hostEditable = !isShareProjectKey(projectPath);

  return (
    <div
      className="overlay-legend"
      role={menu ? "none" : "group"}
      aria-label={menu ? undefined : "Timeline layers"}
    >
      {TOGGLES.map(({ key, label }) => (
        <label key={key} className="overlay-legend-item">
          <input
            type="checkbox"
            role={menu ? "menuitemcheckbox" : undefined}
            aria-checked={menu ? layers[key] : undefined}
            checked={layers[key]}
            onChange={(e) => setLayerVisible(key, e.target.checked)}
          />
          {label}
        </label>
      ))}
      {hostEditable && layers.showMarkers && (
        <Button
          role={menu ? "menuitem" : undefined}
          className="transcript-follow-btn"
          title="Add chapter marker at playhead"
          onClick={() => {
            void (async () => {
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
