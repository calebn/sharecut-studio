/**
 * The key route to the create menu (#1877): `create.menu` is a command, and the
 * menu lives in the mounted timeline, so the timeline registers how to open it
 * here. The command asks; this says whether a timeline answered.
 */
type Opener = () => boolean;

let opener: Opener | null = null;

/** The mounted timeline's way to open the create menu; the returned function unregisters it. */
export function registerCreateMenuOpener(next: Opener): () => void {
  opener = next;
  return () => {
    if (opener === next) opener = null;
  };
}

/** Opens the create menu where the keyboard is, or at the playhead; false when no timeline is mounted or there is no lane. */
export function openCreateMenu(): boolean {
  return opener?.() ?? false;
}
