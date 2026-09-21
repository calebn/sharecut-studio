import { Dialog } from "./Dialog";

type GestureDef = {
  gesture: string;
  command: string;
  description: string;
  available: boolean;
};

const GESTURES: GestureDef[] = [
  {
    gesture: "Two-finger tap",
    command: "Undo",
    description: "Undo the last action. iOS system convention.",
    available: true,
  },
  {
    gesture: "Long-press",
    command: "Context actions",
    description:
      "Open the selection sheet for clips, words, comments, and tracks.",
    available: true,
  },
  {
    gesture: "Pinch",
    command: "Zoom timeline",
    description: "Pinch in/out on the timeline to zoom.",
    available: true,
  },
  {
    gesture: "Swipe left on comment",
    command: "Resolve comment",
    description: "Quick-resolve a comment from the list.",
    available: false,
  },
  {
    gesture: "Double-tap word",
    command: "Correct word",
    description: "Open the word correction sheet.",
    available: false,
  },
];

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * Gestures cheatsheet for mobile. Standalone from the keyboard shortcut
 * modal (CommandPalette) — mobile users don't need keyboard shortcuts,
 * desktop users don't need gestures. Both read from the same command
 * catalog to stay in sync.
 */
export function GesturesSheet({ open, onClose }: Props) {
  return (
    <Dialog open={open} onClose={onClose} title="Gestures">
      <p className="lede">
        Touch gestures for common actions.{" "}
        <span className="text-dim">
          Using a keyboard? See keyboard shortcuts on desktop.
        </span>
      </p>
      <dl className="gesture-list">
        {GESTURES.map((g) => (
          <div key={g.gesture} className="gesture-item">
            <dt className="gesture-name">
              {g.gesture}
              {!g.available && (
                <span className="pill" aria-label="Coming soon">
                  Soon
                </span>
              )}
            </dt>
            <dd className="gesture-detail">
              <strong>{g.command}</strong> — {g.description}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
