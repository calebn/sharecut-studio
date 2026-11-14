import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { resolveCommentAnchor } from "../../comments/commentAnchor";
import { useDawStore } from "../../state/dawStore";
import { Composer, type ComposerProps } from "../../system/Composer";

type Chip = NonNullable<ComposerProps["anchor"]>;

/**
 * The chip follows the playhead until a draft or a selected range pins it.
 * While a selection's words are refreshing it keeps the chip it last showed.
 */
export function ComposeAnchor(props: Omit<ComposerProps, "anchor">) {
  const shown = useRef<Chip | null>(null);
  const anchor = useDawStore(
    useShallow((s): Chip => {
      const resolved = resolveCommentAnchor(s);
      if (resolved.source === "refreshing")
        return shown.current ?? { kind: "follow", seconds: 0 };
      const { draft, source } = resolved;
      return source === "playhead"
        ? { kind: "follow", seconds: Math.floor(draft.startSec) }
        : {
            kind: "pinned",
            start: draft.startSec,
            end: draft.endSec ?? undefined,
          };
    }),
  );
  useEffect(() => {
    shown.current = anchor;
  }, [anchor]);
  return <Composer {...props} anchor={anchor} />;
}
