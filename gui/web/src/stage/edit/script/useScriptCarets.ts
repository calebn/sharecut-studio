import { useMemo } from "react";
import { transcriptWordPresenceAnchor } from "../../../presence/anchors";
import { rosterDisplayName } from "../../../presence/colors";
import { sessionClientList } from "../../../presence/roster";
import { useLivePresenceClients } from "../../../presence/useLivePresenceClients";
import { useDawStore } from "../../../state/dawStore";
import type { ScriptCaret } from "../../../system/scriptPieces";
import type { SessionClient } from "../../../types/session";
import type { ScriptModel } from "./scriptModel";

/** The word anchor a remote person is at: their pointer's, else the start of their word selection. */
function wordAnchorOf(client: SessionClient): string | null {
  const anchor = client.meta?.cursor?.anchor;
  if (anchor?.startsWith("transcript:word:")) return anchor;
  const selection = client.meta?.selection;
  if (
    selection?.track_id &&
    selection.word_index != null &&
    (selection.kind === "transcriptWord" ||
      selection.kind === "transcriptRange")
  ) {
    return transcriptWordPresenceAnchor(
      selection.track_id,
      selection.source_id ?? null,
      selection.word_index,
    );
  }
  return null;
}

/**
 * The carets the pane draws: your own, then one before the word each other
 * live person is at. The local client is never among them. A person whose word
 * the Script does not show (another stage, a cut word) has none.
 */
export function useScriptCarets(
  model: ScriptModel,
  own: readonly ScriptCaret[],
): readonly ScriptCaret[] {
  const roster = useDawStore((s) => s.sessionClients);
  const localClientId = useDawStore((s) => s.localClientId);
  const { others } = useLivePresenceClients(
    sessionClientList(roster),
    localClientId,
  );
  const byAnchor = useMemo(() => {
    const map = new Map<string, number>();
    for (const turn of model.turns) {
      for (const word of turn.words) {
        if (word.anchor) map.set(word.anchor, word.index);
      }
    }
    return map;
  }, [model]);
  return useMemo(() => {
    const remote: ScriptCaret[] = [];
    for (const client of others) {
      const anchor = wordAnchorOf(client);
      const before = anchor === null ? undefined : byAnchor.get(anchor);
      if (before === undefined) continue;
      remote.push({
        before,
        person: {
          name: rosterDisplayName(client),
          colorIndex: client.meta?.color_index ?? 0,
        },
      });
    }
    return remote.length === 0 ? own : [...own, ...remote];
  }, [others, byAnchor, own]);
}
