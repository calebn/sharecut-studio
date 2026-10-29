import { isTypingTarget } from "../keymap/typing";
import { type KeySpec, VERBS, type VerbId } from "../system/verbs";

type StageAction =
  | "verb"
  | "keep"
  | "next"
  | "previous"
  | "hearBefore"
  | "hearAfter"
  | "applyAll"
  | "openInEdit"
  | "comment"
  | "reply";

type KeyInput = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey" | "repeat"
> & { target?: EventTarget | null };

/** Holding these must not decide a second item. */
const DECIDES: readonly StageAction[] = [
  "verb",
  "keep",
  "applyAll",
  "comment",
  "openInEdit",
];

const keysOf = (id: VerbId): readonly KeySpec[] =>
  VERBS.find((entry) => entry.id === id)?.keys ?? [];

const stepsBack = (spec: KeySpec) => spec.shift || spec.key === "ArrowUp";
const NEXT_KEYS = keysOf("next");

/** Chords are exclusive, so order does not matter. */
const BINDINGS: readonly { action: StageAction; keys: readonly KeySpec[] }[] = [
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
  { action: "reply", keys: [{ key: "R" }] },
];
const CUT_KEYS = keysOf("cut");

const normal = (key: string) => (key === " " ? "SPACE" : key.toUpperCase());

function matches(spec: KeySpec, event: KeyInput): boolean {
  return (
    normal(spec.key) === normal(event.key) &&
    Boolean(spec.shift) === event.shiftKey &&
    Boolean(spec.alt) === event.altKey &&
    Boolean(spec.mod) === (event.metaKey || event.ctrlKey)
  );
}

const CONTROL =
  "button, a, summary, [role='slider'], [tabindex]:not([tabindex='-1'])";

const isControl = (
  target: EventTarget | null | undefined,
  root?: Element | null,
) => {
  const control = target instanceof Element ? target.closest(CONTROL) : null;
  return (
    control !== null && (!root || (control !== root && root.contains(control)))
  );
};

/**
 * Keys typed into a field belong to the field. Enter on a control is the
 * control's own activation. Tab leaves the page's focus order alone unless it
 * lands on a plain element inside the stage: never the root, never a control,
 * so a keyboard user can always reach the buttons and the Undo toast. Backspace
 * and Delete are the Cut verb's keys, so they act only when the current item's
 * primary is Cut.
 */
export function stageActionFor(
  event: KeyInput,
  context: { primary?: VerbId; root?: Element | null } = {},
): StageAction | null {
  if (isTypingTarget(event.target ?? null)) return null;
  const action =
    context.primary === "cut" && CUT_KEYS.some((s) => matches(s, event))
      ? "verb"
      : (BINDINGS.find((binding) =>
          binding.keys.some((spec) => matches(spec, event)),
        )?.action ?? null);
  if (!action) return null;
  if (event.repeat && DECIDES.includes(action)) return null;
  if (
    (event.key === "Backspace" || event.key === "Delete") &&
    isControl(event.target, context.root)
  ) {
    return null;
  }
  if (
    event.key === "Tab" &&
    (event.target === context.root || isControl(event.target, context.root))
  ) {
    return null;
  }
  if (
    (action === "verb" || action === "applyAll") &&
    event.key === "Enter" &&
    isControl(event.target, context.root)
  ) {
    return null;
  }
  return action;
}
