import { gestureLabel, MOBILE_GESTURES } from "../commands/gestures";
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
        <button
          type="button"
          className="ui-control--quiet"
          onClick={onShowKeyboardShortcuts}
        >
          Keyboard shortcuts
        </button>
      </p>
      <dl className="gesture-list">
        {MOBILE_GESTURES.map((g) => (
          <div key={g.gesture} className="gesture-item">
            <dt className="gesture-name">{g.gesture}</dt>
            <dd className="gesture-detail">
              <strong>{gestureLabel(g)}</strong> — {g.description}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
