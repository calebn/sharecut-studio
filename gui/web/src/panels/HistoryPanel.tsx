import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { loadHistoryDiff } from "../api";
import { execute } from "../commands/execute";
import { useLatestRequest } from "../hooks/useLatestRequest";
import { useProjectMutation } from "../hooks/useProjectMutation";
import { useVirtualRows } from "../hooks/useVirtualRows";
import { useDaw } from "../state/useDaw";
import type { HistoryDiff, HistoryGroup } from "../types/project";
import { Button, InlineError } from "../ui";
import { errorMessage } from "../utils/apiError";
import { plural } from "../utils/format";
import { historyGroupKey } from "../utils/historyGroupKey";

function groupTitle(g: HistoryGroup): string {
  return g.title ?? g.label ?? g.operation ?? "snapshot";
}

/** Initial history row height (rem) before measurement. */
export const HISTORY_ROW_ESTIMATE_REM = 2.25;
const EMPTY_GROUPS: HistoryGroup[] = [];

export function HistoryPanel() {
  const { project, projectPath } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
  }));
  const { busy, error, run, setError } = useProjectMutation();
  const [diff, setDiff] = useState<HistoryDiff | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [loading, setLoading] = useState(false);
  /** Only the latest diff request may apply its result. */
  const diffRequest = useLatestRequest();

  const listRef = useRef<HTMLDivElement>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const groups = project?.history.groups ?? EMPTY_GROUPS;
  const keys = useMemo(() => groups.map(historyGroupKey), [groups]);
  const selectedIndex = selectedKey === null ? -1 : keys.indexOf(selectedKey);
  const focusedIndex = focusedKey === null ? -1 : keys.indexOf(focusedKey);
  /** The selected step left `groups` (redo tail dropped, history reloaded). */
  const selectionStale = selectedKey !== null && selectedIndex === -1;
  const shownDiff = selectionStale ? null : diff;
  const diffLoading = loading && !selectionStale;
  // A step that left the list takes its selection, diff and pending load with
  // it, so a reload that brings the same key back starts unselected.
  useEffect(() => {
    if (!selectionStale) {
      return;
    }
    diffRequest.invalidate();
    setSelectedKey(null);
    setDiff(null);
    setLoading(false);
  }, [selectionStale, diffRequest]);
  // Pinned rows: the selected and the focused step.
  const pinned = useMemo(
    () => [selectedIndex, focusedIndex].filter((index) => index >= 0),
    [selectedIndex, focusedIndex],
  );
  const getItemKey = useCallback((i: number) => keys[i] ?? i, [keys]);
  const {
    virtualized,
    items: virtualItems,
    totalSize,
    slotProps,
  } = useVirtualRows(listRef, {
    count: groups.length,
    getItemKey,
    estimateRem: HISTORY_ROW_ESTIMATE_REM,
    pinned,
  });

  if (!project) {
    return null;
  }

  const { can_undo, can_redo } = project.history;
  const historyHydrated = project.meta.hydration?.history_groups !== false;

  const runHistoryAction = async (action: "undo" | "redo") => {
    await run(async () => {
      await execute(
        action === "undo" ? "history.undo" : "history.redo",
        {},
        { skipWhen: true },
      );
      diffRequest.invalidate();
      setDiff(null);
      setSelectedKey(null);
      setLoading(false);
    });
  };

  const openDiff = async (
    key: string,
    beforeIndex: number,
    afterIndex: number,
  ) => {
    const request = diffRequest.begin();
    setSelectedKey(key);
    setLoading(true);
    setError(null);
    try {
      const d = await loadHistoryDiff(projectPath, beforeIndex, afterIndex);
      if (!diffRequest.isCurrent(request)) {
        return;
      }
      setDiff(d);
      setShowRaw(false);
    } catch (e) {
      if (!diffRequest.isCurrent(request)) {
        return;
      }
      setDiff(null);
      setError(errorMessage(e, "Could not load the history diff"));
    } finally {
      if (diffRequest.isCurrent(request)) {
        setLoading(false);
      }
    }
  };

  const renderRow = (g: HistoryGroup, i: number): ReactNode => {
    const key = keys[i]!;
    const clickable =
      g.kind === "mutation" && g.before_index != null && g.after_index != null;
    const selected = selectedKey === key;
    const rowClass = `history-row${clickable ? " clickable" : ""}${selected ? " selected" : ""}`;
    const rowBody = (
      <>
        <span className="history-kind">
          {g.kind === "mutation" ? "⟳" : "•"}
        </span>
        <span className="history-title">{groupTitle(g)}</span>
        {g.created_at && (
          <span className="history-when">
            {g.created_at.replace("T", " ").slice(0, 19)}
          </span>
        )}
      </>
    );
    if (clickable) {
      return (
        <button
          data-history-index={i}
          onFocus={() => setFocusedKey(key)}
          onBlur={() => setFocusedKey(null)}
          type="button"
          className={rowClass}
          onClick={() => void openDiff(key, g.before_index!, g.after_index!)}
        >
          {rowBody}
        </button>
      );
    }
    return (
      <div className={rowClass} data-history-index={i}>
        {rowBody}
      </div>
    );
  };

  return (
    <div className="history-panel">
      <div className="history-toolbar">
        <div className="history-toolbar-actions">
          <Button
            disabled={busy || !can_undo}
            onClick={() => void runHistoryAction("undo")}
          >
            Undo
          </Button>
          <Button
            disabled={busy || !can_redo}
            onClick={() => void runHistoryAction("redo")}
          >
            Redo
          </Button>
          {historyHydrated ? (
            <span className="transcript-meta">
              {groups.length === 0
                ? "No edits yet"
                : `${groups.length} ${plural(groups.length, "step")}`}
            </span>
          ) : null}
        </div>
        <InlineError message={error} />
      </div>
      {!historyHydrated ? (
        <p className="transcript-meta">Loading history…</p>
      ) : null}
      <div
        ref={listRef}
        className={`history-list${virtualized ? " is-virtualized" : ""}`}
        aria-busy={!historyHydrated || undefined}
        {...(virtualized
          ? { role: "list", "aria-label": `History, ${groups.length} steps` }
          : {})}
      >
        {virtualized ? (
          <>
            <div
              className="history-virtual-spacer"
              aria-hidden="true"
              style={{ height: totalSize }}
            />
            {virtualItems.map((item) => (
              <div
                key={item.key}
                className="history-row-slot"
                {...slotProps(item)}
              >
                {renderRow(groups[item.index]!, item.index)}
              </div>
            ))}
          </>
        ) : (
          groups.map((g, i) => (
            <Fragment key={keys[i]}>{renderRow(g, i)}</Fragment>
          ))
        )}
      </div>
      {(shownDiff || diffLoading) && (
        <div className="history-diff">
          <div className="history-diff-header">
            <strong>
              {diffLoading
                ? "Loading…"
                : (shownDiff?.to_label?.replace(/^after\s+/, "") ?? "Diff")}
            </strong>
            {shownDiff && (
              <Button
                className="transcript-follow-btn"
                onClick={() => setShowRaw((v) => !v)}
              >
                {showRaw ? "Summary" : "Raw JSON"}
              </Button>
            )}
          </div>
          {shownDiff && !showRaw && (
            <ul className="history-summary">
              {(shownDiff.summary?.length
                ? shownDiff.summary
                : ["No summary available"]
              ).map((line, i) => (
                <li key={`${line}-${i}`}>{line}</li>
              ))}
            </ul>
          )}
          {shownDiff && showRaw && (
            <pre className="history-raw">
              {JSON.stringify(shownDiff.diff, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
