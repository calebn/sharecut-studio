import { useState } from "react";
import { loadHistoryDiff } from "../api";
import { execute } from "../commands/execute";
import { useProjectMutation } from "../hooks/useProjectMutation";
import { useDaw } from "../state/useDaw";
import type { HistoryDiff, HistoryGroup } from "../types/project";
import { Button, InlineError } from "../ui";

function groupTitle(g: HistoryGroup): string {
  return g.title ?? g.label ?? g.operation ?? "snapshot";
}

export function HistoryPanel() {
  const { project, projectPath } = useDaw();
  const { busy, error, run } = useProjectMutation();
  const [diff, setDiff] = useState<HistoryDiff | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!project) {
    return null;
  }

  const { cursor, can_undo, can_redo, groups } = project.history;
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
          <span className="transcript-meta">
            cursor {cursor}
            {historyHydrated ? (
              <>
                {" · "}
                {groups.length} step{groups.length === 1 ? "" : "s"}
              </>
            ) : null}
          </span>
        </div>
        <InlineError message={error} />
      </div>
      <div className="history-list" aria-busy={!historyHydrated || undefined}>
        {!historyHydrated ? (
          <p className="transcript-meta">Loading history…</p>
        ) : null}
        {groups.map((g, i) => {
          const key =
            g.kind === "mutation"
              ? `m-${g.before_index}-${g.after_index}`
              : `s-${g.index ?? i}`;
          const clickable =
            g.kind === "mutation" &&
            g.before_index != null &&
            g.after_index != null;
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
                key={key}
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
            <div key={key} className={rowClass}>
              {rowBody}
            </div>
          );
        })}
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
