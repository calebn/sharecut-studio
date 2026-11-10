import { type RefObject, useMemo, useRef, useState } from "react";
import {
  previewTranscriptReplacement,
  replaceTranscriptMatches,
  replyHistoryHead,
} from "../../../api";
import { submitRangeEdit } from "../../../commands/rangeActions";
import { makeRangeTarget } from "../../../edit/rangeSelection";
import {
  loadCommandQueue,
  loadHostCommandQueue,
} from "../../../services/offlineQueue/offlineStore";
import { isShareProjectKey, shareTokenFromKey } from "../../../shareMode";
import type { FindBarHandle } from "../../../stages/edit/FindBar";
import {
  findCountText,
  findMatches,
  replacementChanges,
} from "../../../stages/edit/findMatches";
import { useDawStore } from "../../../state/dawStore";
import type { FindHit } from "../../../system/scriptPieces";
import { ApiError } from "../../../utils/apiError";
import { useStableCallback } from "../../../utils/useStableCallback";
import { cutAllMessage, cutKey, matchCutOf } from "./findCut";
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
  replaceAll: () => Promise<number>;
};

function cutAllFailure(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.code === "cut_scope_changed") {
    if (/need audio review/.test(error.message))
      return new Error(
        "Some of these matches are held for an audio check. Nothing was cut.",
      );
    if (/needs another review/.test(error.message))
      return new Error(
        "Nothing was cut. The host has to review this edit first.",
      );
    return new Error("Nothing was cut. The edit was not applied.");
  }
  if (error.code === "overlapping_targets")
    return new Error(
      "Some matches overlap on one track, so nothing was cut. Try a narrower search or cut them in the timeline.",
    );
  return error;
}

function wasProposed(result: Record<string, unknown>): boolean {
  const command = result.command as
    | { payload?: { result?: { proposed?: unknown } } }
    | undefined;
  return command?.payload?.result?.proposed === true;
}

async function queuedIds(projectPath: string): Promise<Set<string>> {
  const rows = isShareProjectKey(projectPath)
    ? await loadCommandQueue(shareTokenFromKey(projectPath)!)
    : await loadHostCommandQueue(projectPath);
  return new Set(rows.map((row) => row.command_id));
}

/**
 * Find over the whole transcript (the model's turns, not the window), the
 * hits the pane highlights, and the host's Replace all through the backend's
 * preview and its token. Replace all is queued when the host is offline, so
 * its toast never carries a count.
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
  const queued = useRef(
    new Map<string, { epoch: number; commandId: string }>(),
  );
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
      projectPath,
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
    const key = cutKey(plan.targets);
    const offline = navigator.onLine === false;
    setRangeBusy(true);
    try {
      const mine = queued.current;
      for (const [other, entry] of mine)
        if (entry.epoch !== epoch) mine.delete(other);
      if (mine.size > 0) {
        const ids = await queuedIds(projectPath).catch(() => null);
        if (useDawStore.getState().projectEpoch !== epoch) return;
        if (!ids) throw new Error("Nothing was cut. Try again.");
        for (const [other, entry] of mine)
          if (!ids.has(entry.commandId)) mine.delete(other);
        if (mine.has(key))
          throw new Error("Cut all is already queued. Wait for it to send.");
      }
      const result = await submitRangeEdit("cut", plan.targets).catch(
        (error: unknown) => {
          throw cutAllFailure(error);
        },
      );
      if (useDawStore.getState().projectEpoch !== epoch) return;
      if (result.queued === true) {
        queued.current.set(key, {
          epoch,
          commandId: String(result.command_id),
        });
        announceStatus(
          isShareProjectKey(projectPath) && offline
            ? "Cut all queued as a suggestion for host review. Reconnect to send it."
            : "Cut all queued. Still sending.",
        );
        return;
      }
      if (wasProposed(result)) {
        announceStatus(
          "Cut all was suggested for review. Nothing was cut yet.",
        );
        return;
      }
      if (result.type !== "Applied") {
        announceStatus("Nothing was cut. The edit was not applied.", {
          tone: "error",
        });
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
