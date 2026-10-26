import { isTypingTarget } from "../keymap/typing";
import { type KeySpec, VERBS, type VerbId } from "../system/verbs";

export type ReviewAction =
  | "verb"
  | "keep"
  | "next"
  | "previous"
  | "hearBefore"
  | "hearAfter"
  | "applyAll"
  | "openInEdit"
  | "comment";

export type ReviewKeyEvent = {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  target?: EventTarget | null;
};

const keysOf = (id: VerbId): readonly KeySpec[] => {
  const verb = VERBS.find((entry) => entry.id === id);
  if (!verb) throw new Error(`Unknown verb ${id}`);
  return verb.keys;
};

/** Tab and ArrowDown step forward; Shift+Tab and ArrowUp step back. */
const stepsBack = (spec: KeySpec) => spec.shift || spec.key === "ArrowUp";
const NEXT_KEYS = keysOf("next");

/** Keys come from the verb table. Chords are exclusive, so order does not matter. */
const BINDINGS: readonly { action: ReviewAction; keys: readonly KeySpec[] }[] =
  [
    { action: "verb", keys: keysOf("approve") },
    { action: "keep", keys: keysOf("keep") },
    { action: "next", keys: NEXT_KEYS.filter((spec) => !stepsBack(spec)) },
    { action: "previous", keys: NEXT_KEYS.filter(stepsBack) },
    { action: "hearBefore", keys: keysOf("hearBefore") },
    { action: "hearAfter", keys: keysOf("hearAfter") },
    { action: "applyAll", keys: keysOf("applyAll") },
    {
      action: "openInEdit",
      keys: keysOf("goToStage").filter((spec) => spec.key === "E"),
    },
    { action: "comment", keys: keysOf("comment") },
  ];
const CUT_KEYS = keysOf("cut");

const normal = (key: string) => (key === " " ? "SPACE" : key.toUpperCase());

function matches(spec: KeySpec, event: ReviewKeyEvent): boolean {
  return (
    normal(spec.key) === normal(event.key) &&
    Boolean(spec.shift) === event.shiftKey &&
    Boolean(spec.alt) === event.altKey &&
    Boolean(spec.mod) === (event.metaKey || event.ctrlKey)
  );
}

const CONTROL =
  "button, a, summary, [role='slider'], [tabindex]:not([tabindex='-1'])";

const isControl = (target: EventTarget | null | undefined) =>
  target instanceof Element && target.closest(CONTROL) !== null;

/**
 * Keys typed into a field belong to the field. Tab and Shift+Tab keep their
 * focus order on any other control, and Enter on a button is the button's own
 * activation. Backspace and Delete are the Cut verb's keys, so they act only
 * when the current item's primary is Cut.
 */
export function reviewActionFor(
  event: ReviewKeyEvent,
  context: { primary?: VerbId } = {},
): ReviewAction | null {
  if (isTypingTarget(event.target ?? null)) return null;
  const action =
    context.primary === "cut" && CUT_KEYS.some((s) => matches(s, event))
      ? "verb"
      : (BINDINGS.find((binding) =>
          binding.keys.some((spec) => matches(spec, event)),
        )?.action ?? null);
  if (!action) return null;
  if (event.key === "Tab" && isControl(event.target)) return null;
  if (
    (action === "verb" || action === "applyAll") &&
    event.key === "Enter" &&
    isControl(event.target)
  ) {
    return null;
  }
  return action;
}
