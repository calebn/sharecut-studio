import { useShallow } from "zustand/react/shallow";
import { resolveCommentAnchor } from "../../comments/commentAnchor";
import { useDawStore } from "../../state/dawStore";
import { Composer, type ComposerProps } from "../../system/Composer";

/** The chip follows the playhead until a draft or a selected range pins it. */
export function ComposeAnchor(props: Omit<ComposerProps, "anchor">) {
  const anchor = useDawStore(
    useShallow((s) => {
      const { draft, source } = resolveCommentAnchor(s);
      return source === "playhead"
        ? { kind: "follow" as const, seconds: Math.floor(draft.startSec) }
        : {
            kind: "pinned" as const,
            start: draft.startSec,
            end: draft.endSec ?? undefined,
          };
    }),
  );
  return <Composer {...props} anchor={anchor} />;
}
