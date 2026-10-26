import { capsOf } from "./verbDisplay";
import type { KeySpec } from "./verbs";

/** Display-only key caps; the row's label already names the action. */
export function KeyCaps({ chords }: { chords: readonly KeySpec[] }) {
  if (chords.length === 0) return null;
  return (
    <span className="sys-keys" aria-hidden="true">
      {chords.slice(0, 2).map((chord) => (
        <span key={capsOf(chord).join("")} className="sys-keys-chord">
          {capsOf(chord).map((cap) => (
            <kbd key={cap} className="sys-key">
              {cap}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  );
}
