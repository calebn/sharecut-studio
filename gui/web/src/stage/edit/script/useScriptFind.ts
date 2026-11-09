import { type RefObject, useMemo, useState } from "react";
import {
  previewTranscriptReplacement,
  replaceTranscriptMatches,
} from "../../../api";
import { replyHistoryHead } from "../../../api/documentEdits";
import { submitRangeEdit } from "../../../commands/rangeActions";
import { makeRangeTarget } from "../../../edit/rangeSelection";
import type { FindBarHandle } from "../../../stages/edit/FindBar";
import {
  findCountText,
  findMatches,
  replacementChanges,
} from "../../../stages/edit/findMatches";
import { useDawStore } from "../../../state/dawStore";
import type { FindHit } from "../../../system/scriptPieces";
import { useStableCallback } from "../../../utils/useStableCallback";
import { cutAllMessage, matchCutOf } from "./findCut";
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
  matches: readonly FindHit[];
  /** The current hit, or -1 when there is none. */
  current: number;
  /** What the pane's live region says about the search; undefined while the bar is closed. */
  status: string | undefined;
  /** Counts the steps to a match, so a repeated status ("1 of 1") is announced again. */
  statusKey: number;
  openBar: () => void;
  closeBar: () => void;
  setQuery: (query: string) => void;
  setCaseSensitive: (on: boolean) => void;
  setReplaceOpen: (open: boolean) => void;
  setReplaceText: (text: string) => void;
  next: () => void;
  previous: () => void;
  selectAll: () => void;
  /** Cuts every hit, each speaker's own audio only, as one undoable edit. Rejects with a message the bar shows. */
  cutAll: () => Promise<void>;
  replaceAll: () => Promise<number>;
};

/**
 * Find over the whole transcript (the model's turns, not the window), the
 * hits the pane highlights, and the host's Replace all through the backend's
 * preview and its token. Replace all is queued when the host is offline, so
 * its toast never carries a count. Cut all sends one target per speaker in one
 * command. A single Replace is left out until the backend can address one match.
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
  const [stepped, setStepped] = useState(0);
  const { query, caseSensitive, replaceText } = state;
  const matches = useMemo(
    () => (open ? findMatches(model.turns, query, caseSensitive) : []),
    [open, model.turns, query, caseSensitive],
  );
  const current = matches.length === 0 ? -1 : Math.min(at, matches.length - 1);

  const go = (list: readonly FindHit[], to: number) => {
    setAt(to);
    const hit = list[to];
    if (hit) scrollTo(hit.indices[0], "center");
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
    setStepped((n) => n + 1);
    go(matches, (Math.max(current, 0) + by + matches.length) % matches.length);
  };

  const selectAll = () => {
    const { project, setSelection } = useDawStore.getState();
    const spans: { start: number; end: number }[] = [];
    const trackIds = new Set<string>();
    for (const hit of matches) {
      for (const index of hit.indices) {
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

  const cutAll = async () => {
    const {
      project,
      rangeBusy,
      joinMutationInFlight,
      announceStatus,
      projectEpoch: epoch,
      setRangeBusy,
    } = useDawStore.getState();
    if (!project) throw new Error("Open a project");
    if (rangeBusy || joinMutationInFlight)
      throw new Error("Wait for the current edit to finish.");
    const plan = matchCutOf(project, model, matches);
    if (plan.targets.length === 0)
      throw new Error("No audible words in these matches.");
    setRangeBusy(true);
    try {
      const result = await submitRangeEdit("cut", plan.targets);
      if (useDawStore.getState().projectEpoch !== epoch) return;
      if (result.queued === true) {
        announceStatus("Cut all queued. Still sending.");
        return;
      }
      announceStatus(cutAllMessage(plan.cut, plan.skipped), {
        undo: replyHistoryHead(result),
      });
    } finally {
      if (useDawStore.getState().projectEpoch === epoch) setRangeBusy(false);
    }
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
    open,
    matches,
    current,
    status: open ? findCountText(query, matches.length, current) : undefined,
    statusKey: stepped,
    openBar,
    closeBar,
    setQuery: (value) => edit({ query: value }),
    setCaseSensitive: (on) => edit({ caseSensitive: on }),
    setReplaceOpen: (value) => edit({ replaceOpen: value }),
    setReplaceText: (value) => edit({ replaceText: value }),
    next: () => step(1),
    previous: () => step(-1),
    selectAll,
    cutAll,
    replaceAll,
  };
}
