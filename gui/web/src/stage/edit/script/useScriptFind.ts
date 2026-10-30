import { type RefObject, useMemo, useState } from "react";
import {
  previewTranscriptReplacement,
  replaceTranscriptMatches,
} from "../../../api";
import { makeRangeTarget } from "../../../edit/rangeSelection";
import type { FindBarHandle } from "../../../stages/edit/FindBar";
import {
  findCountText,
  findMatches,
  replacementChanges,
} from "../../../stages/edit/findMatches";
import { useDawStore } from "../../../state/dawStore";
import type { ScriptSpan } from "../../../system/scriptPieces";
import { useStableCallback } from "../../../utils/useStableCallback";
import type { ScriptModel } from "./scriptModel";

export type ScriptFindState = {
  query: string;
  caseSensitive: boolean;
  replaceOpen: boolean;
  replaceText: string;
};

export type ScriptFind = ScriptFindState & {
  /** Whether the bar shows: the store's find flag, which `transcript.findReplace` toggles. */
  open: boolean;
  matches: readonly ScriptSpan[];
  /** The current hit, or -1 when there is none. */
  current: number;
  /** What the pane's live region says about the search; undefined while the bar is closed. */
  status: string | undefined;
  openBar: () => void;
  closeBar: () => void;
  setQuery: (query: string) => void;
  setCaseSensitive: (on: boolean) => void;
  setReplaceOpen: (open: boolean) => void;
  setReplaceText: (text: string) => void;
  next: () => void;
  previous: () => void;
  selectAll: () => void;
  replaceAll: () => Promise<number>;
};

/**
 * Find over the whole transcript (the model's turns, not the window), the
 * hits the pane highlights, and the host's Replace all through the backend's
 * preview and its token. Replace all is queued when the host is offline, so
 * its toast never carries a count. Cut all and a single Replace have no
 * command yet and are left out.
 */
export function useScriptFind(
  model: ScriptModel,
  bar: RefObject<FindBarHandle | null>,
  scrollTo: (index: number, block?: ScrollLogicalPosition) => boolean,
  say: (message: string) => void,
): ScriptFind {
  const open = useDawStore((s) => s.chrome.transcriptFindReplaceOpen);
  const [state, setState] = useState<ScriptFindState>({
    query: "",
    caseSensitive: false,
    replaceOpen: false,
    replaceText: "",
  });
  const [at, setAt] = useState(0);
  const { query, caseSensitive, replaceText } = state;
  const matches = useMemo(
    () => (open ? findMatches(model.turns, query, caseSensitive) : []),
    [open, model.turns, query, caseSensitive],
  );
  const current = matches.length === 0 ? -1 : Math.min(at, matches.length - 1);

  const go = (list: readonly ScriptSpan[], to: number) => {
    setAt(to);
    const hit = list[to];
    if (hit) scrollTo(hit.start, "center");
  };
  const edit = (patch: Partial<ScriptFindState>) => {
    const next = { ...state, ...patch };
    setState(next);
    if ("query" in patch || "caseSensitive" in patch) {
      go(findMatches(model.turns, next.query, next.caseSensitive), 0);
    }
  };

  const openBar = useStableCallback(() => {
    if (open) bar.current?.focus();
    else useDawStore.getState().setTranscriptFindReplaceOpen(true);
  });
  const closeBar = useStableCallback(() =>
    useDawStore.getState().setTranscriptFindReplaceOpen(false),
  );
  const step = (by: number) => {
    if (matches.length === 0) return;
    go(matches, (Math.max(current, 0) + by + matches.length) % matches.length);
  };

  const selectAll = () => {
    const { project, setSelection } = useDawStore.getState();
    const spans: { start: number; end: number }[] = [];
    const trackIds = new Set<string>();
    for (const hit of matches) {
      for (let index = hit.start; index <= hit.end; index++) {
        const time = model.timeOf(index);
        if (time) spans.push(time);
        const ref = model.refs[index];
        if (ref) trackIds.add(ref.trackId);
      }
    }
    const target = project
      ? makeRangeTarget(project, spans, [...trackIds])
      : null;
    if (!target) return;
    setSelection({ kind: "range", target });
    say(
      `${matches.length} ${matches.length === 1 ? "match" : "matches"} selected`,
    );
  };

  const replaceAll = async () => {
    const { projectPath, announceStatus } = useDawStore.getState();
    const options = {
      search: query,
      replacement: replaceText,
      match_case: caseSensitive,
    };
    const preview = await previewTranscriptReplacement(projectPath, options);
    if (preview.count === 0) throw new Error("No words to replace.");
    const result = await replaceTranscriptMatches(
      projectPath,
      options,
      preview.preview_token,
    );
    // The result may be queued, with no count to give, so the toast carries none.
    announceStatus(
      result.queued
        ? "Replace queued. Still sending."
        : "Replaced the matching words",
    );
    return replacementChanges(model.turns, matches, replaceText).length;
  };

  return {
    ...state,
    matches,
    current,
    status: open ? findCountText(query, matches.length, current) : undefined,
    openBar,
    closeBar,
    setQuery: (value) => edit({ query: value }),
    setCaseSensitive: (on) => edit({ caseSensitive: on }),
    setReplaceOpen: (value) => edit({ replaceOpen: value }),
    setReplaceText: (value) => edit({ replaceText: value }),
    next: () => step(1),
    previous: () => step(-1),
    selectAll,
    replaceAll,
  };
}
