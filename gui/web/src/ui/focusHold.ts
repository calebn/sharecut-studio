type FocusHold = (document: Document) => boolean;

const holds = new Set<FocusHold>();

/**
 * Marks focus that entry focus in `ui/` and views must leave alone: a hold
 * answers true while the user is on a control they chose on purpose. Each
 * registration is its own entry, so unregistering one never drops another
 * that shares its predicate. Returns the unregister function.
 */
export function registerFocusHold(hold: FocusHold): () => void {
  const entry: FocusHold = (document) => hold(document);
  holds.add(entry);
  return () => holds.delete(entry);
}

export function focusHeld(document: Document): boolean {
  for (const hold of holds) if (hold(document)) return true;
  return false;
}
