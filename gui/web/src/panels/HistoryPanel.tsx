import {
  Fragment,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { loadHistoryDiff } from "../api";
import { execute } from "../commands/execute";
import { useProjectMutation } from "../hooks/useProjectMutation";
import { useVirtualRows } from "../hooks/useVirtualRows";
import { useDaw } from "../state/useDaw";
import type { HistoryDiff, HistoryGroup } from "../types/project";
import { Button, InlineError } from "../ui";
import { plural } from "../utils/format";

function groupTitle(g: HistoryGroup): string {
  return g.title ?? g.label ?? g.operation ?? "snapshot";
}

/** Stable row key: mutation pairs by index pair, snapshots by index. */
function historyGroupKey(g: HistoryGroup, i: number): string {
  return g.kind === "mutation"
    ? `m-${g.before_index}-${g.after_index}`
    : `s-${g.index ?? i}`;
}

/** Initial history row height (rem) before measurement. */
export const HISTORY_ROW_ESTIMATE_REM = 2.25;
const EMPTY_GROUPS: HistoryGroup[] = [];

export function HistoryPanel() {
  const { project, projectPath } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
  }));
  const { busy, error, run } = useProjectMutation();
  const [diff, setDiff] = useState<HistoryDiff | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [loading, setLoading] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const groups = project?.history.groups ?? EMPTY_GROUPS;
  const keys = useMemo(() => groups.map(historyGroupKey), [groups]);
  const selectedIndex = selectedKey === null ? -1 : keys.indexOf(selectedKey);
  const pinned = useMemo(
    () => [selectedIndex, focusedIndex ?? -1].filter((index) => index >= 0),
    [selectedIndex, focusedIndex],
  );
  const getItemKey = useCallback((i: number) => keys[i] ?? i, [keys]);
  const {
    virtualized,
    items: virtualItems,
    totalSize,
    measureElement,
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
      setDiff(null);
      setSelectedKey(null);
    });
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
          onFocus={() => setFocusedIndex(i)}
          onBlur={() => setFocusedIndex(null)}
          type="button"
          className={rowClass}
          onClick={() => {
            void (async () => {
              setSelectedKey(key);
              setLoading(true);
              try {
                const d = await loadHistoryDiff(
                  projectPath,
                  g.before_index!,
                  g.after_index!,
                );
                setDiff(d);
                setShowRaw(false);
              } finally {
                setLoading(false);
              }
            })();
          }}
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
      <div
        ref={listRef}
        className={`history-list${virtualized ? " is-virtualized" : ""}`}
        aria-busy={!historyHydrated || undefined}
        {...(virtualized
          ? { role: "list", "aria-label": `History, ${groups.length} steps` }
          : {})}
      >
        {!historyHydrated ? (
          <p className="transcript-meta">Loading history…</p>
        ) : null}
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
                role="listitem"
                aria-setsize={groups.length}
                aria-posinset={item.index + 1}
                data-index={item.index}
                ref={measureElement}
                style={{ transform: `translateY(${item.start}px)` }}
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
      {(diff || loading) && (
        <div className="history-diff">
          <div className="history-diff-header">
            <strong>
              {loading
                ? "Loading…"
                : (diff?.to_label?.replace(/^after\s+/, "") ?? "Diff")}
            </strong>
            {diff && (
              <Button
                className="transcript-follow-btn"
                onClick={() => setShowRaw((v) => !v)}
              >
                {showRaw ? "Summary" : "Raw JSON"}
              </Button>
            )}
          </div>
          {diff && !showRaw && (
            <ul className="history-summary">
              {(diff.summary?.length
                ? diff.summary
                : ["No summary available"]
              ).map((line, i) => (
                <li key={`${line}-${i}`}>{line}</li>
              ))}
            </ul>
          )}
          {diff && showRaw && (
            <pre className="history-raw">
              {JSON.stringify(diff.diff, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
