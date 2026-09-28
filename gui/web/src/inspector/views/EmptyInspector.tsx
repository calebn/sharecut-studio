import { presenceAnchor, presenceAnchorProps } from "../../presence/anchors";
import type { PendingEditView } from "../../types/project";
import { Button } from "../../ui";
import { unmappedPendingLabel } from "../../utils/edits";

export function EmptyInspector({
  unmappable,
  onSelectPending,
}: {
  unmappable: PendingEditView[];
  onSelectPending: (edit: PendingEditView) => void;
}) {
  return (
    <aside
      className="inspector"
      {...presenceAnchorProps(presenceAnchor("inspector"))}
    >
      <h2>Inspector</h2>
      <p style={{ color: "var(--text-dim)" }}>
        Click a clip, edit, track header, chapter marker, or Levels envelope
        point.
      </p>
      {unmappable.length > 0 && (
        <>
          <h2>{unmappedPendingLabel(unmappable.length)}</h2>
          <p
            style={{
              color: "var(--text-dim)",
              fontSize: "var(--font-size-caption)",
            }}
          >
            These edits fall in audio that has been removed from the timeline,
            so they cannot be drawn there.
          </p>
          <ul className="unmapped-list">
            {unmappable.map((e) => (
              <li key={e.id}>
                <Button variant="link" onClick={() => onSelectPending(e)}>
                  {e.type}: {e.reason ?? e.id}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
