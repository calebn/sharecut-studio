import { composerPatch, initialSession } from "../state/composerSession";
import type { CommentDraft } from "../state/types";

/** `useDawStore.setState` fields for a store with no comment being written. */
export const noComposer = composerPatch(initialSession);

/** Fields for a store whose composer is open at `anchor`. */
export function composing(
  anchor: CommentDraft,
  over: { text?: string; resume?: boolean } = {},
) {
  return composerPatch({
    ...initialSession,
    surface: "composer",
    draft: {
      text: over.text ?? "",
      anchor,
      resume: over.resume ?? false,
      typed: false,
    },
  });
}
