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
 * Store-free command palette: search every runnable command by name, keyword,
 * category or shortcut, run it, and read or remap its keys. Open via ?, Menu →
 * Help, or More → Commands and shortcuts on phones.
 *
 * Search is a combobox over a listbox of commands. Focus stays in Search;
 * the arrow keys move the active command (`aria-activedescendant`), unavailable
 * ones included so their reasons are read, and Enter runs it. Typing makes the
 * first runnable match active. The status line names the command Enter runs.
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
  const [picked, setPicked] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const searchRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-commands`;
  const optionId = (id: string) => `${baseId}-${id}`;

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setShowRemap(false);
      setPicked(null);
    }
  }

  const searching = query.trim() !== "";
  const shown = searchPaletteCommands(commands, query);
  const listed = !showRemap && shown.length > 0;
  const active = listed
    ? (shown.find((c) => c.id === picked) ??
      (searching ? shown.find((c) => c.disabledReason == null) : undefined) ??
      null)
    : null;
  const activeDomId = active ? optionId(active.id) : undefined;

  useEffect(() => {
    if (activeDomId) {
      document
        .getElementById(activeDomId)
        ?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeDomId]);

  function onSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!listed) {
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const at = active ? shown.indexOf(active) : -1;
      const next =
        e.key === "ArrowDown"
          ? Math.min(at + 1, shown.length - 1)
          : Math.max(at - 1, 0);
      setPicked(shown[next]?.id ?? null);
    } else if (e.key === "Enter" && active) {
      e.preventDefault();
      if (active.disabledReason == null) {
        onRun(active.id);
      }
    }
  }

  const status = [
    searching
      ? `${shown.length} ${shown.length === 1 ? "command" : "commands"}`
      : "",
    active
      ? active.disabledReason == null
        ? `Enter runs ${active.label}`
        : `${active.label} is unavailable: ${active.disabledReason}`
      : "",
  ]
    .filter(Boolean)
    .join(". ");

  const option = (row: PaletteCommand, showCategory: boolean) => (
    <PaletteOption
      key={row.id}
      id={optionId(row.id)}
      row={row}
      active={row.id === active?.id}
      showCategory={showCategory}
      onRun={onRun}
    />
  );

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
        role="combobox"
        className="command-palette-search"
        aria-label="Search commands"
        aria-autocomplete="list"
        aria-expanded={listed}
        aria-controls={listed ? listboxId : undefined}
        aria-activedescendant={activeDomId}
        placeholder="Search commands"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="go"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setPicked(null);
        }}
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
          {status}
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

      {searching && shown.length === 0 ? (
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
      {showRemap ? <RemapList rows={shown} onRemap={onRemap} /> : null}
      {listed ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Commands"
          className="command-palette-listbox"
        >
          {searching
            ? shown.map((row) => option(row, true))
            : groupPaletteCommands(shown).map(({ category, rows }) => {
                const labelId = `${baseId}-group-${category}`;
                return (
                  <div
                    key={category}
                    role="group"
                    aria-labelledby={labelId}
                    className="command-palette-group"
                  >
                    <div id={labelId} className="command-palette-group-label">
                      {PALETTE_CATEGORY_LABELS[category]}
                    </div>
                    {rows.map((row) => option(row, false))}
                  </div>
                );
              })}
        </div>
      ) : null}
    </Dialog>
  );
}

function PaletteOption({
  id,
  row,
  active,
  showCategory,
  onRun,
}: {
  id: string;
  row: PaletteCommand;
  active: boolean;
  showCategory: boolean;
  onRun: (id: string) => void;
}) {
  const disabled = row.disabledReason != null;
  const note = row.disabledReason ?? row.note;
  const keysId = `${id}-keys`;
  const noteId = `${id}-note`;
  const describedBy = [row.shortcut ? keysId : null, note ? noteId : null]
    .filter(Boolean)
    .join(" ");
  const run = () => {
    if (!disabled) {
      onRun(row.id);
    }
  };
  return (
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      aria-disabled={disabled || undefined}
      aria-labelledby={`${id}-label`}
      aria-describedby={describedBy || undefined}
      className="command-palette-option"
      // Keep focus in Search, which owns the keyboard.
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      // Search owns the keyboard; this covers assistive tech that moves real
      // focus onto an option.
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          run();
        }
      }}
    >
      <span className="command-palette-option-main">
        <span id={`${id}-label`} className="command-palette-label">
          {row.label}
          {showCategory ? (
            <span className="command-palette-category">
              {PALETTE_CATEGORY_LABELS[row.category]}
            </span>
          ) : null}
        </span>
        {row.shortcut ? <kbd id={keysId}>{row.shortcut}</kbd> : null}
      </span>
      {note ? (
        <span id={noteId} className="command-palette-note">
          {note}
        </span>
      ) : null}
    </div>
  );
}

/** "Show remaps": a key field for each matching command that has keys. */
function RemapList({
  rows,
  onRemap,
}: {
  rows: readonly PaletteCommand[];
  onRemap: (id: string, trimmedKey: string) => void;
}) {
  const keyed = rows.filter((row) => row.defaultKey != null);
  if (keyed.length === 0) {
    return null;
  }
  return (
    <ul className="command-palette-list">
      {keyed.map((row) => (
        <li key={row.id} className="command-palette-remap-row">
          <span className="command-palette-label">{row.label}</span>
          {row.shortcut ? <kbd>{row.shortcut}</kbd> : null}
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
        </li>
      ))}
    </ul>
  );
}
