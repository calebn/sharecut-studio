type FocusHold = (document: Document) => boolean;

const holds = new Set<FocusHold>();

/**
 * Lets a feature module mark focus it must keep (a toast action the user
 * moved to on purpose) so entry focus in `ui/` and views yields to it.
 * Returns the unregister function.
 */
export function registerFocusHold(hold: FocusHold): () => void {
  holds.add(hold);
  return () => holds.delete(hold);
}

export function focusHeld(document: Document): boolean {
  for (const hold of holds) if (hold(document)) return true;
  return false;
}
