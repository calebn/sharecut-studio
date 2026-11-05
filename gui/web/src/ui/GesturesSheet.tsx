import { gestureLabel, MOBILE_GESTURES } from "../commands/gestures";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

type Props = {
  open: boolean;
  onClose: () => void;
  onShowKeyboardShortcuts: () => void;
};

/**
 * Gestures cheatsheet for mobile. It stays separate from the keyboard
 * shortcut modal while both surfaces cross-link and use the shared command
 * catalog for implemented actions.
 */
export function GesturesSheet({
  open,
  onClose,
  onShowKeyboardShortcuts,
}: Props) {
  return (
    <Dialog open={open} onClose={onClose} title="Gestures">
      <p className="lede">
        Touch gestures for common actions.{" "}
        <Button variant="link" onClick={onShowKeyboardShortcuts}>
          Commands and shortcuts
        </Button>
      </p>
      <p>
        To move a clip without dragging, select it, open its inspector and scrub
        Start, or tap a track in its Track row. The change saves when you
        release. Escape drops it. The Moved clips message offers Undo for the
        saved move, including a selected group. A move waiting to send offers no
        Undo. On desktop and tablet, Shorter, Taller, and Reset panel size
        change the editor panels. On phone, drag the sheet's grip up or down.
      </p>
      <dl className="gesture-list">
        {MOBILE_GESTURES.map((g) => (
          <div key={g.gesture} className="gesture-item">
            <dt className="gesture-name">{g.gesture}</dt>
            <dd className="gesture-detail">
              <strong>{gestureLabel(g)}</strong>: {g.description}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
