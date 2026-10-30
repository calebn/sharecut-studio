import { useMemo, useRef } from "react";
import { seekTransport } from "../../../commands/seek";
import { useDawStore } from "../../../state/dawStore";
import type { TranscriptReviewCursor } from "../../../state/types";
import {
  type LowConfidenceStop,
  stepLowConfidence,
} from "../../../transcript/lowConfidence";
import { useStableCallback } from "../../../utils/useStableCallback";
import type { ScriptModel } from "./scriptModel";

/**
 * The jump to the next word the transcript is unsure of. The count and the
 * walk are over the whole episode and leave bleed-only rows out, as the old
 * review did. The walk goes from the last word it visited and wraps. It is
 * not `transcript.nextLowConfidence`, which also turns Annotate on.
 */
export function useScriptUnsure(
  model: ScriptModel,
  texts: readonly string[],
  unsure: readonly number[],
  scrollTo: (index: number, block?: ScrollLogicalPosition) => boolean,
  say: (message: string) => void,
): () => void {
  const stops = useMemo<LowConfidenceStop[]>(
    () =>
      unsure.flatMap((index) => {
        const ref = model.refs[index];
        if (!ref) return [];
        const seekSec = model.seekSecOf(index);
        return [
          {
            trackId: ref.trackId,
            sourceId: ref.sourceId,
            wordIndex: ref.wordIndex,
            text: texts[index] ?? "",
            seekSec,
            order: index,
          },
        ];
      }),
    [model, texts, unsure],
  );
  const cursor = useRef<TranscriptReviewCursor | null>(null);

  return useStableCallback(() => {
    const at = stepLowConfidence(stops, cursor.current, "next");
    const stop = stops[at];
    if (!stop) return;
    cursor.current = {
      trackId: stop.trackId,
      sourceId: stop.sourceId,
      wordIndex: stop.wordIndex,
      order: stop.order,
    };
    useDawStore.getState().setSelection({
      kind: "transcriptRange",
      trackId: stop.trackId,
      sourceId: stop.sourceId,
      startWordIndex: stop.wordIndex,
      endWordIndex: stop.wordIndex,
    });
    if (stop.seekSec !== null) void seekTransport(stop.seekSec);
    scrollTo(stop.order, "center");
    say(`Unsure word ${at + 1} of ${stops.length}: ${stop.text}`);
  });
}
