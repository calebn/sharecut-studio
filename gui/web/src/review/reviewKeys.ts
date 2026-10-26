import { type KeySpec, VERBS, type VerbId } from "../system/verbs";

export type ReviewAction =
  | "verb"
  | "keep"
  | "later"
  | "previous"
  | "hearBefore"
  | "hearAfter"
  | "hear"
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

type Binding = { action: ReviewAction; keys: readonly KeySpec[] };

const keysOf = (id: VerbId): readonly KeySpec[] =>
  VERBS.find((verb) => verb.id === id)?.keys ?? [];

const NEXT_KEYS = keysOf("next");
const PRIMARY_KEYS = keysOf("approve");
const CUT_KEYS = keysOf("cut");

/** Every key comes from the verb table. Order matters only for readability: chords are exclusive. */
const BINDINGS: readonly Binding[] = [
  { action: "verb", keys: PRIMARY_KEYS },
  { action: "keep", keys: keysOf("keep") },
  { action: "later", keys: keysOf("later") },
  {
    action: "previous",
    keys: NEXT_KEYS.filter((spec) => spec.shift || spec.key === "ArrowUp"),
  },
  { action: "hearBefore", keys: keysOf("hearBefore") },
  { action: "hearAfter", keys: keysOf("hearAfter") },
  { action: "hear", keys: keysOf("hear") },
  { action: "applyAll", keys: keysOf("applyAll") },
  {
    action: "openInEdit",
    keys: keysOf("goToStage").filter((s) => s.key === "E"),
  },
  { action: "comment", keys: keysOf("comment") },
];

const normal = (key: string) => (key === " " ? "SPACE" : key.toUpperCase());

function matches(spec: KeySpec, event: ReviewKeyEvent): boolean {
  return (
    normal(spec.key) === normal(event.key) &&
    Boolean(spec.shift) === event.shiftKey &&
    Boolean(spec.alt) === event.altKey &&
    Boolean(spec.mod) === (event.metaKey || event.ctrlKey)
  );
}

export function isEditableTarget(target: EventTarget | null | undefined) {
  if (!target || typeof (target as Element).closest !== "function")
    return false;
  return (
    (target as Element).closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
    ) !== null
  );
}

/**
 * The action a key does while a Review item is current, or null. Keys typed
 * into a field belong to the field. Backspace and Delete are the Cut verb's
 * keys, so they act only when the current item's primary is Cut.
 */
export function reviewActionFor(
  event: ReviewKeyEvent,
  context: { primary?: VerbId } = {},
): ReviewAction | null {
  if (isEditableTarget(event.target)) return null;
  if (context.primary === "cut" && CUT_KEYS.some((s) => matches(s, event))) {
    return "verb";
  }
  return (
    BINDINGS.find((binding) =>
      binding.keys.some((spec) => matches(spec, event)),
    )?.action ?? null
  );
}
