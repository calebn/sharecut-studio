/** Non-reactive stack of open inline confirms, so Escape cancels the newest before any dialog closes. */
const keepers: Array<() => void> = [];

/** Register an open confirm's Keep handler; the returned function unregisters it. */
export function registerInlineConfirm(keep: () => void): () => void {
  keepers.push(keep);
  return () => {
    const at = keepers.lastIndexOf(keep);
    if (at >= 0) {
      keepers.splice(at, 1);
    }
  };
}

/** Keep (cancel) the newest open confirm. False when none is open, so Escape falls through. */
export function cancelInlineConfirm(): boolean {
  const keep = keepers.at(-1);
  if (!keep) {
    return false;
  }
  keep();
  return true;
}
