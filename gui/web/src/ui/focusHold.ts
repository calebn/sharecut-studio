type FocusHold = (document: Document) => boolean;

const holds = new Set<FocusHold>();

/**
 * Marks focus that entry focus in `ui/` and views must leave alone. Each call
 * is its own registration, so unregistering one never drops another that
 * shares its predicate. Returns the unregister function.
 */
export function registerFocusHold(hold: FocusHold): () => void {
  const registration: FocusHold = (document) => hold(document);
  holds.add(registration);
  return () => holds.delete(registration);
}

export function focusHeld(document: Document): boolean {
  for (const hold of holds) if (hold(document)) return true;
  return false;
}
