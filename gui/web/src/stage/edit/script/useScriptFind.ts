import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  previewTranscriptReplacement,
  replaceTranscriptMatches,
  replyHistoryHead,
} from "../../../api";
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
import { cutHits } from "./cutHits";
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
  cutAll: () => Promise<void>;
  replaceOneReason: string | undefined;
  replaceOne: () => Promise<void>;
  replaceAll: () => Promise<number>;
};

/**
 * Find over the whole transcript (the model's turns, not the window), the
 * hits the pane highlights, and the host's Replace and Replace all through the
 * backend's preview and its token. Both are queued when the host is offline, so
 * a queued toast never carries a count.
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
  const current =
    matches.length === 0 || at < 0 ? -1 : Math.min(at, matches.length - 1);

  const replaceBusy = useRef(false);
  const go = (list: readonly FindHit[], to: number) => {
    setAt(to);
    const hit = list[to];
    if (hit) scrollTo(hit.indices[0], "center");
  };
  const edit = (patch: Partial<ScriptFindState>) => {
    const next = { ...state, ...patch };
    setState(next);
    replaceBusy.current = false;
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
    if (current < 0) return go(matches, by > 0 ? 0 : matches.length - 1);
    go(matches, (current + by + matches.length) % matches.length);
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

  const cutAll = () => cutHits(model, matches);

  const refsOf = (hit: FindHit | undefined) => {
    const refs = (hit?.indices ?? []).map((index) => model.refs[index]);
    const first = refs[0];
    const last = refs[refs.length - 1];
    if (!first || !last || first.wordIndex === null || last.wordIndex === null)
      return null;
    return { first, last, from: hit?.indices[0] ?? 0 };
  };
  const replaceOneReason =
    current >= 0 && refsOf(matches[current]) === null
      ? "This match has no saved word position yet. Use Replace all."
      : undefined;

  const pendingAdvance = useRef<{
    turns: ScriptModel["turns"];
    from: number;
    to: number;
  } | null>(null);
  const advance = useStableCallback(() => {
    const job = pendingAdvance.current;
    if (!job || job.turns === model.turns) return;
    pendingAdvance.current = null;
    replaceBusy.current = false;
    if (matches.length === 0) return;
    const to = matches.findIndex((hit) => hit.indices[0] >= job.to);
    if (to !== -1) return go(matches, to);
    const before = matches.findLastIndex((hit) => hit.indices[0] < job.from);
    go(matches, before);
  });
  useEffect(advance, [model.turns, advance]);

  const replaceOne = async () => {
    if (replaceBusy.current) return;
    const hit = matches[current];
    const where = refsOf(hit);
    if (!hit || !where)
      throw new Error(replaceOneReason ?? "Choose a match to replace.");
    if (replacementChanges(model.turns, [hit], replaceText).length === 0)
      throw new Error("That match already reads this way.");
    const { projectPath, announceStatus } = useDawStore.getState();
    const options = {
      search: query,
      replacement: replaceText,
      match_case: caseSensitive,
    };
    const shown = model.turns
      .flatMap((turn) => turn.words)
      .filter((word) => hit.indices.includes(word.index))
      .map((word) => word.text)
      .join(" ");
    replaceBusy.current = true;
    let preview: Awaited<ReturnType<typeof previewTranscriptReplacement>>;
    try {
      preview = await previewTranscriptReplacement(projectPath, options);
    } catch (error) {
      replaceBusy.current = false;
      throw error;
    }
    const only = preview.matches.findIndex(
      (match) =>
        match.track_id === where.first.trackId &&
        (match.source_id ?? null) === where.first.sourceId &&
        match.start_word_index === where.first.wordIndex &&
        match.end_word_index === where.last.wordIndex &&
        match.before === shown,
    );
    if (only < 0) {
      replaceBusy.current = false;
      throw new Error("That match changed. Find it again.");
    }
    const added = replaceText.split(/\s+/).filter(Boolean).length;
    pendingAdvance.current = {
      turns: model.turns,
      from: where.from,
      to: where.from + added,
    };
    try {
      const result = await replaceTranscriptMatches(
        projectPath,
        options,
        preview.preview_token,
        only,
      );
      if (result.queued) {
        pendingAdvance.current = null;
        replaceBusy.current = false;
        announceStatus("Replace queued. Still sending.");
        return;
      }
      announceStatus("Replaced 1", { undo: replyHistoryHead(result) });
    } catch (error) {
      pendingAdvance.current = null;
      replaceBusy.current = false;
      throw error;
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
    replaceOneReason,
    replaceOne,
    replaceAll,
  };
}
