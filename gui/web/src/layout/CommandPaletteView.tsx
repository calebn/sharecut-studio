import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Button, Dialog } from "../ui";
import {
  groupPaletteCommands,
  PALETTE_CATEGORY_LABELS,
  type PaletteCommand,
  searchPaletteCommands,
} from "./paletteSearch";

export interface CommandPaletteViewProps {
  open: boolean;
  /** Runnable catalog commands in category order (see `paletteCommands`). */
  commands: readonly PaletteCommand[];
  onClose: () => void;
  onOpenGestures: () => void;
  onRun: (id: string) => void;
  onRemap: (id: string, trimmedKey: string) => void;
}

/**
 * Store-free command palette: search every runnable command by name, category
 * or shortcut, run it, and read or remap its keys. Open via ?, Menu → Help, or
 * More → Commands and shortcuts on phones.
 */
export function CommandPaletteView({
  open,
  commands,
  onClose,
  onOpenGestures,
  onRun,
  onRemap,
}: CommandPaletteViewProps) {
  const [query, setQuery] = useState("");
  const [showRemap, setShowRemap] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const resultsId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    setShowRemap(false);
  }, [open]);

  const searching = query.trim() !== "";
  const results = searchPaletteCommands(commands, query);
  const runnable = results.filter((c) => c.disabledReason == null);

  const runButtons = () => [
    ...(listRef.current?.querySelectorAll<HTMLButtonElement>(
      "button.command-palette-run:not(:disabled)",
    ) ?? []),
  ];

  function onSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      runButtons()[0]?.focus();
    } else if (e.key === "Enter" && searching && runnable[0]) {
      e.preventDefault();
      onRun(runnable[0].id);
    }
  }

  function onRowKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") {
      return;
    }
    const buttons = runButtons();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) {
      return;
    }
    e.preventDefault();
    const next = at + (e.key === "ArrowDown" ? 1 : -1);
    if (next < 0) {
      searchRef.current?.focus();
    } else {
      buttons[Math.min(next, buttons.length - 1)]?.focus();
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Commands and shortcuts"
      panelClassName="command-palette-dialog"
      initialFocusRef={searchRef}
      phoneSheet
    >
      <input
        ref={searchRef}
        type="search"
        className="command-palette-search"
        aria-label="Search commands"
        aria-controls={resultsId}
        placeholder="Search commands"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onSearchKeyDown}
      />
      <p className="command-palette-hint">
        Press <kbd>?</kbd> anytime. Character keys only apply when the timeline
        or transcript has focus.{" "}
        <Button variant="link" onClick={onOpenGestures}>
          Gestures
        </Button>
      </p>
      <div className="command-palette-toolbar">
        <p className="command-palette-count" role="status">
          {searching
            ? `${results.length} ${results.length === 1 ? "command" : "commands"}`
            : ""}
        </p>
        <label className="command-palette-remap-toggle">
          <input
            type="checkbox"
            checked={showRemap}
            onChange={(e) => setShowRemap(e.target.checked)}
          />
          Show remaps
        </label>
      </div>

      <div id={resultsId} ref={listRef}>
        {searching && results.length === 0 ? (
          <div className="command-palette-empty">
            <p>No commands match “{query.trim()}”.</p>
            <Button
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              Clear search
            </Button>
          </div>
        ) : null}
        {searching ? (
          <PaletteList
            rows={results}
            showCategory
            showRemap={showRemap}
            onRun={onRun}
            onRemap={onRemap}
            onRowKeyDown={onRowKeyDown}
          />
        ) : (
          groupPaletteCommands(commands).map(({ category, rows }) => (
            <section key={category} className="command-palette-section">
              <h3>{PALETTE_CATEGORY_LABELS[category]}</h3>
              <PaletteList
                rows={rows}
                showRemap={showRemap}
                onRun={onRun}
                onRemap={onRemap}
                onRowKeyDown={onRowKeyDown}
              />
            </section>
          ))
        )}
      </div>
    </Dialog>
  );
}

function PaletteList({
  rows,
  showCategory = false,
  showRemap,
  onRun,
  onRemap,
  onRowKeyDown,
}: {
  rows: readonly PaletteCommand[];
  showCategory?: boolean;
  showRemap: boolean;
  onRun: (id: string) => void;
  onRemap: (id: string, trimmedKey: string) => void;
  /** Arrow keys step between rows and back up to Search. */
  onRowKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <ul className="command-palette-list">
      {rows.map((row) => {
        const noteId = `command-palette-note-${row.id}`;
        const note = row.disabledReason ?? row.note;
        return (
          <li key={row.id}>
            <button
              type="button"
              className="ui-control command-palette-run"
              disabled={row.disabledReason != null}
              aria-describedby={note ? noteId : undefined}
              onClick={() => onRun(row.id)}
              onKeyDown={onRowKeyDown}
            >
              <span className="command-palette-label">
                {row.label}
                {showCategory ? (
                  <span className="command-palette-category">
                    {PALETTE_CATEGORY_LABELS[row.category]}
                  </span>
                ) : null}
              </span>
              {row.shortcut ? <kbd>{row.shortcut}</kbd> : null}
            </button>
            {note ? (
              <p id={noteId} className="command-palette-note">
                {note}
              </p>
            ) : null}
            {showRemap && row.defaultKey != null ? (
              <label className="command-palette-remap">
                Remap
                <input
                  aria-label={`Remap ${row.label}`}
                  placeholder={row.defaultKey}
                  onBlur={(e) => {
                    onRemap(row.id, e.target.value.trim());
                  }}
                />
              </label>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
